require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
// Import DeleteCommand
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, ScanCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const app = express();
const port = 3000;

// Middleware for parsing JSON requests
app.use(express.json());
// Serve static files from the 'public' directory
app.use(express.static('public'));

// Configure AWS SDK
const client = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.DYNAMODB_TABLE_NAME; // Ensure this is set to 'Tests' in your .env

// --- API Endpoints ---

app.get('/api/admin/check', async (req, res) => {
    try {
        // A simple way to check if the backend's credentials have admin-like access
        // Attempt a low-impact admin action (like listing tables).
        // If it succeeds, we assume the backend has admin capabilities.
        await client.send(new ListTablesCommand({ Limit: 1 }));
        res.json({ isAdmin: true, message: "Backend has admin capabilities." });
    } catch (error) {
        // If ListTables fails (e.g., AccessDeniedException), then backend is not admin-capable
        console.warn('Admin check failed:', error.name);
        res.json({ isAdmin: false, message: "Backend does not have admin capabilities for table creation." });
    }
});

app.post('/api/admin/create-table', async (req, res) => {
    const { tableName, partitionKeyName, partitionKeyType } = req.body;

    if (!tableName || !partitionKeyName || !partitionKeyType) {
        return res.status(400).json({ message: 'Table name, partition key name, and type are required.' });
    }

    const params = {
        TableName: tableName,
        AttributeDefinitions: [
            {
                AttributeName: partitionKeyName,
                AttributeType: partitionKeyType
            }
        ],
        KeySchema: [
            {
                AttributeName: partitionKeyName,
                KeyType: "HASH"
            }
        ],
        BillingMode: "PAY_PER_REQUEST"
    };

    try {
        console.log(`Attempting to create table: ${tableName}`);
        const command = new CreateTableCommand(params);
        const data = await client.send(command);
        console.log("Table creation response:", data);
        res.status(200).json({ message: `Table '${tableName}' creation initiated.`, tableDescription: data.TableDescription });
    } catch (error) {
        console.error('Error creating table:', error);
        if (error.name === 'ResourceInUseException') {
            res.status(409).json({ message: `Table '${tableName}' already exists.`, error: error.message });
        } else if (error.name === 'AccessDeniedException') {
            res.status(403).json({ message: 'Access Denied: Check IAM permissions for table creation.', error: error.message });
        } else {
            res.status(500).json({ message: 'Failed to create table.', error: error.message });
        }
    }
});

// Example: Get an item by Email (Partition Key)
app.get('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    const params = {
        TableName: tableName,
        Key: {
            Email: email, // Use 'Email' as the partition key
        },
    };
    try {
        const { Item } = await docClient.send(new GetCommand(params));
        if (Item) {
            res.json(Item);
        } else {
            res.status(404).send('Item not found');
        }
    } catch (error) {
        console.error('Error getting item:', error);
        res.status(500).send('Error getting item');
    }
});

// Add/Put item (modified to also set createdAt/updatedAt)
app.post('/api/tests', async (req, res) => {
    const { Email, Nama, Nohp } = req.body;
    if (!Email || !Nama || !Nohp) { return res.status(400).send('Email, Nama, and Nohp are required.'); }

    const now = new Date().toISOString();
    const newItem = {
        Email,
        Nama,
        Nohp,
        createdAt: now, // Set createdAt on initial creation
        updatedAt: now  // Also set updatedAt
    };

    const params = {
        TableName: tableName,
        Item: newItem,
    };
    try {
        await docClient.send(new PutCommand(params));
        res.status(201).json({ message: 'Item added successfully', item: newItem });
    } catch (error) {
        console.error('Error adding item:', error);
        res.status(500).send('Error adding item');
    }
});

// NEW: Update an item by Email
app.patch('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    const { Nama, Nohp } = req.body; // Attributes to update

    if (!email) {
        return res.status(400).json({ message: 'Email is required for update.' });
    }

    const now = new Date().toISOString();
    let UpdateExpression = 'SET updatedAt = :updatedAt';
    let ExpressionAttributeValues = { ':updatedAt': now };
    let ExpressionAttributeNames = {}; // No attribute names needed if no reserved words in Nama, Nohp

    if (Nama) {
        UpdateExpression += ', Nama = :nama';
        ExpressionAttributeValues[':nama'] = Nama;
    }
    if (Nohp) {
        UpdateExpression += ', Nohp = :nohp';
        ExpressionAttributeValues[':nohp'] = Nohp;
    }

    const params = {
        TableName: tableName,
        Key: { Email: email },
        UpdateExpression,
        ExpressionAttributeValues,
        // No ExpressionAttributeNames needed unless 'Nama' or 'Nohp' were DynamoDB reserved words
        ReturnValues: 'ALL_NEW' // Returns the item after update
    };

    try {
        const { Attributes } = await docClient.send(new UpdateCommand(params));
        res.status(200).json({ message: `Item with Email: ${email} updated successfully.`, updatedItem: Attributes });
    } catch (error) {
        console.error('Error updating item:', error);
        if (error.name === 'ConditionalCheckFailedException') {
            res.status(404).json({ message: 'Item not found or condition failed.', error: error.message });
        } else {
            res.status(500).json({ message: 'Failed to update item.', error: error.message });
        }
    }
});

// NEW: Delete an item by Email (Partition Key)
app.delete('/api/tests/:email', async (req, res) => {
    const { email } = req.params;
    const params = {
        TableName: tableName,
        Key: {
            Email: email, // Use 'Email' as the partition key for deletion
        },
    };
    try {
        await docClient.send(new DeleteCommand(params));
        res.status(200).json({ message: `Item with Email: ${email} deleted successfully.` });
    } catch (error) {
        console.error('Error deleting item:', error);
        res.status(500).send('Error deleting item');
    }
});


// Example: Scan (read all items - use with caution for large tables)
app.get('/api/tests', async (req, res) => {
    const params = {
        TableName: tableName,
    };
    try {
        const { Items } = await docClient.send(new ScanCommand(params));
        res.json(Items);
    } catch (error) {
        console.error('Error scanning items:', error);
        res.status(500).send('Error scanning items');
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});