require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const session = require('express-session');
const path = require('path');
const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const port = 3000;

// --- User Configuration ---
const appUserIdentifiers = process.env.APP_USERS ? process.env.APP_USERS.split(',') : [];
const userConfigs = {};
appUserIdentifiers.forEach(id => {
    id = id.trim();
    userConfigs[id] = {
        aws_access_key_id: process.env[`${id}_AWS_ACCESS_KEY_ID`],
        aws_secret_access_key: process.env[`${id}_AWS_SECRET_ACCESS_KEY`],
        aws_region: process.env[`${id}_AWS_REGION`],
        display_name: process.env[`${id}_DISPLAY_NAME`] || id,
        is_admin: process.env[`${id}_IS_ADMIN`] === 'true', // Check for admin capability
    };
});

// Middleware for parsing JSON requests
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For parsing application/x-www-form-urlencoded (form submissions)
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files from 'public' (CSS, client-side JS if any separate)

// Session middleware setup
app.use(session({
    secret: process.env.APP_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- DynamoDB Client Helper ---
// Gets a DynamoDB client configured for the current session user
function getDynamoDBClientForCurrentUser(req) {
    const userId = req.session.user || (appUserIdentifiers.length > 0 ? appUserIdentifiers[0].trim() : null);
    if (!userId || !userConfigs[userId]) {
        throw new Error('User configuration not found or no user in session.');
    }
    const config = userConfigs[userId];
    const client = new DynamoDBClient({
        region: config.aws_region,
        credentials: {
            accessKeyId: config.aws_access_key_id,
            secretAccessKey: config.aws_secret_access_key,
        },
    });
    return { ddbClient: client, docClient: DynamoDBDocumentClient.from(client), userConfig: config };
}

const defaultTableName = process.env.DYNAMODB_TABLE_NAME;

// --- API Endpoints ---

// --- Page Rendering Routes ---
app.get('/', (req, res) => {
    const defaultUserIdentifier = appUserIdentifiers.length > 0 ? appUserIdentifiers[0].trim() : null;
    if (!req.session.user && defaultUserIdentifier) {
        req.session.user = defaultUserIdentifier; // Initialize session with the first user
    }
    const currentUserIdentifier = req.session.user;
    const currentUserConfig = currentUserIdentifier ? userConfigs[currentUserIdentifier] : null;

    res.render('index', {
        currentUserIdentifier: currentUserIdentifier,
        currentUserDisplayName: currentUserConfig ? currentUserConfig.display_name : 'N/A',
        isCurrentUserAdmin: currentUserConfig ? currentUserConfig.is_admin : false,
        availableUsers: appUserIdentifiers.map(id => ({
            identifier: id.trim(),
            displayName: userConfigs[id.trim()].display_name
        })),
        initialTableName: defaultTableName // Pass the default table name
    });
});

app.post('/switch_user/:userId', (req, res) => {
    const userId = req.params.userId;
    if (userConfigs[userId]) {
        req.session.user = userId;
        console.log(`Switched to user: ${userId}`);
    } else {
        console.warn(`Attempted to switch to invalid user: ${userId}`);
    }
    res.redirect('/');
});

// --- API Endpoints (modified to use session-based client) ---
app.get('/api/admin/check', async (req, res) => {
    try {
        const { ddbClient, userConfig } = getDynamoDBClientForCurrentUser(req);
        if (!userConfig.is_admin) { // Use our custom flag first
            return res.json({ isAdmin: false, message: "Current user is not configured as admin." });
        }
        // Attempt a low-impact admin action (like listing tables).
        await ddbClient.send(new ListTablesCommand({ Limit: 1 }));
        res.json({ isAdmin: true, message: "Backend has admin capabilities for the current user." });
    } catch (error) {
        console.warn(`Admin check failed for user ${req.session.user}:`, error.name, error.message);
        res.status(500).json({ isAdmin: false, message: "Admin check failed or user does not have permissions.", error: error.message });
    }
});

app.post('/api/admin/create-table', async (req, res) => {
    const { tableName, partitionKeyName, partitionKeyType } = req.body;

    if (!tableName || !partitionKeyName || !partitionKeyType) {
        return res.status(400).json({ message: 'Table name, partition key name, and type are required.' });
    }

    try {
        const { ddbClient, userConfig } = getDynamoDBClientForCurrentUser(req);
        if (!userConfig.is_admin) {
            return res.status(403).json({ message: 'Current user does not have admin privileges configured.' });
        }

        const params = {
            TableName: tableName,
            AttributeDefinitions: [{ AttributeName: partitionKeyName, AttributeType: partitionKeyType }],
            KeySchema: [{ AttributeName: partitionKeyName, KeyType: "HASH" }],
            BillingMode: "PAY_PER_REQUEST"
        };
        console.log(`User ${req.session.user} attempting to create table: ${tableName}`);
        const command = new CreateTableCommand(params);
        const data = await ddbClient.send(command);
        res.status(200).json({ message: `Table '${tableName}' creation initiated.`, tableDescription: data.TableDescription });
    } catch (error) {
        console.error(`Error creating table by user ${req.session.user}:`, error);
        if (error.name === 'ResourceInUseException') {
            res.status(409).json({ message: `Table '${tableName}' already exists.`, error: error.message });
        } else if (error.name === 'AccessDeniedException') {
            res.status(403).json({ message: 'Access Denied: Check IAM permissions for table creation.', error: error.message });
        } else {
            res.status(500).json({ message: 'Failed to create table.', error: error.message });
        }
    }
});

// Get Item by Email (Partition Key)
app.get('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    try {
        const { docClient } = getDynamoDBClientForCurrentUser(req);
        const params = { TableName: defaultTableName, Key: { Email: email } };
        const { Item } = await docClient.send(new GetCommand(params));
        if (Item) res.json(Item);
        else res.status(404).send('Item not found');
    } catch (error) {
        console.error(`Error getting item by user ${req.session.user}:`, error);
        res.status(500).send('Error getting item');
    }
});

// Add/Put item
// Add/Put item
app.post('/api/tests', async (req, res) => {
    const { Email, Nama, Nohp } = req.body;
    if (!Email || !Nama || !Nohp) { return res.status(400).send('Email, Nama, and Nohp are required.'); }
    const now = new Date().toISOString();
    const newItem = { Email, Nama, Nohp, createdAt: now, updatedAt: now };
    try {
        const { docClient } = getDynamoDBClientForCurrentUser(req);
        const params = { TableName: defaultTableName, Item: newItem };
        await docClient.send(new PutCommand(params));
        res.status(201).json({ message: 'Item added successfully', item: newItem });
    } catch (error) {
        console.error(`Error adding item by user ${req.session.user}:`, error);
        res.status(500).send('Error adding item');
    }
});

// Update an item
app.patch('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    const { Nama, Nohp } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required for update.' });

    const now = new Date().toISOString();
    let UpdateExpression = 'SET updatedAt = :updatedAt';
    let ExpressionAttributeValues = { ':updatedAt': now };

    if (Nama) { UpdateExpression += ', Nama = :nama'; ExpressionAttributeValues[':nama'] = Nama; }
    if (Nohp) { UpdateExpression += ', Nohp = :nohp'; ExpressionAttributeValues[':nohp'] = Nohp; }

    try {
        const { docClient } = getDynamoDBClientForCurrentUser(req);
        const params = {
            TableName: defaultTableName,
            Key: { Email: email },
            UpdateExpression,
            ExpressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };
        const { Attributes } = await docClient.send(new UpdateCommand(params));
        res.status(200).json({ message: `Item with Email: ${email} updated.`, updatedItem: Attributes });
    } catch (error) {
        console.error(`Error updating item by user ${req.session.user}:`, error);
        if (error.name === 'ConditionalCheckFailedException') {
            res.status(404).json({ message: 'Item not found or condition failed.', error: error.message });
        } else {
            res.status(500).json({ message: 'Failed to update item.', error: error.message });
        }
    }
});


// Delete an item
app.delete('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    try {
        const { docClient } = getDynamoDBClientForCurrentUser(req);
        const params = { TableName: defaultTableName, Key: { Email: email } };
        await docClient.send(new DeleteCommand(params));
        res.status(200).json({ message: `Item with Email: ${email} deleted.` });
    } catch (error) {
        console.error(`Error deleting item by user ${req.session.user}:`, error);
        res.status(500).send('Error deleting item');
    }
});

// Scan all items
app.get('/api/tests', async (req, res) => {
    try {
        const { docClient } = getDynamoDBClientForCurrentUser(req);
        const params = { TableName: defaultTableName };
        const { Items } = await docClient.send(new ScanCommand(params));
        res.json(Items);
    } catch (error) {
        console.error(`Error scanning items by user ${req.session.user}:`, error);
        res.status(500).send('Error scanning items');
    }
});

// --- Server Start ---
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
    if (appUserIdentifiers.length === 0) {
        console.warn("Warning: APP_USERS is not defined in .env or is empty. User switching will not function correctly.");
    } else {
        console.log("Available user configurations:", Object.keys(userConfigs));
    }
});