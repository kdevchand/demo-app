const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;
const SERVICE_NAME = 'user-service';

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// In-memory data store
let users = [
  { id: '1', name: 'Alice Johnson', email: 'alice@example.com', role: 'customer', createdAt: new Date().toISOString() },
  { id: '2', name: 'Bob Smith', email: 'bob@example.com', role: 'customer', createdAt: new Date().toISOString() },
  { id: '3', name: 'Charlie Brown', email: 'charlie@example.com', role: 'admin', createdAt: new Date().toISOString() }
];

let isReady = false;

// Simulate startup initialization
setTimeout(() => {
  isReady = true;
  console.log(`[${SERVICE_NAME}] Service is ready`);
}, 2000);

// ---- Health & Readiness ----
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: SERVICE_NAME, timestamp: new Date().toISOString() });
});

app.get('/ready', (req, res) => {
  if (isReady) {
    res.status(200).json({ status: 'ready', service: SERVICE_NAME });
  } else {
    res.status(503).json({ status: 'not ready', service: SERVICE_NAME });
  }
});

// ---- API Routes ----

// GET /api/users - List all users
app.get('/api/users', (req, res) => {
  res.status(200).json({
    success: true,
    count: users.length,
    data: users
  });
});

// GET /api/users/:id - Get user by ID
app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === req.params.id);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  res.status(200).json({ success: true, data: user });
});

// POST /api/users - Create user
app.post('/api/users', (req, res) => {
  const { name, email, role } = req.body;

  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'Name and email are required' });
  }

  const existingUser = users.find(u => u.email === email);
  if (existingUser) {
    return res.status(409).json({ success: false, error: 'User with this email already exists' });
  }

  const newUser = {
    id: uuidv4(),
    name,
    email,
    role: role || 'customer',
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  res.status(201).json({ success: true, data: newUser });
});

// ---- Error Handler ----
app.use((err, req, res, next) => {
  console.error(`[${SERVICE_NAME}] Error:`, err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// ---- Start Server ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] Running on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;