const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3002;
const SERVICE_NAME = 'product-service';

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// In-memory data store with seed data
let products = [
  { id: '1', name: 'Wireless Mouse', description: 'Ergonomic wireless mouse with USB receiver', price: 29.99, category: 'electronics', stock: 150, createdAt: new Date().toISOString() },
  { id: '2', name: 'Mechanical Keyboard', description: 'RGB mechanical keyboard with Cherry MX switches', price: 89.99, category: 'electronics', stock: 75, createdAt: new Date().toISOString() },
  { id: '3', name: 'USB-C Hub', description: '7-in-1 USB-C hub with HDMI and ethernet', price: 45.99, category: 'accessories', stock: 200, createdAt: new Date().toISOString() },
  { id: '4', name: 'Monitor Stand', description: 'Adjustable aluminum monitor stand', price: 34.99, category: 'accessories', stock: 120, createdAt: new Date().toISOString() },
  { id: '5', name: 'Laptop Backpack', description: 'Water-resistant laptop backpack 15.6 inch', price: 49.99, category: 'bags', stock: 90, createdAt: new Date().toISOString() }
];

let isReady = false;

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

// GET /api/products - List all products
app.get('/api/products', (req, res) => {
  let result = [...products];

  // Optional category filter
  if (req.query.category) {
    result = result.filter(p => p.category === req.query.category);
  }

  // Optional price range filter
  if (req.query.min_price) {
    result = result.filter(p => p.price >= parseFloat(req.query.min_price));
  }
  if (req.query.max_price) {
    result = result.filter(p => p.price <= parseFloat(req.query.max_price));
  }

  res.status(200).json({
    success: true,
    count: result.length,
    data: result
  });
});

// GET /api/products/:id - Get product by ID
app.get('/api/products/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  if (!product) {
    return res.status(404).json({ success: false, error: 'Product not found' });
  }
  res.status(200).json({ success: true, data: product });
});

// POST /api/products - Create product
app.post('/api/products', (req, res) => {
  const { name, description, price, category, stock } = req.body;

  if (!name || !price) {
    return res.status(400).json({ success: false, error: 'Name and price are required' });
  }

  if (typeof price !== 'number' || price <= 0) {
    return res.status(400).json({ success: false, error: 'Price must be a positive number' });
  }

  const newProduct = {
    id: uuidv4(),
    name,
    description: description || '',
    price,
    category: category || 'general',
    stock: stock || 0,
    createdAt: new Date().toISOString()
  };

  products.push(newProduct);
  res.status(201).json({ success: true, data: newProduct });
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
  console.log(`[${SERVICE_NAME}] Loaded ${products.length} seed products`);
});

module.exports = app;