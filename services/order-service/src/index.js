const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3003;
const SERVICE_NAME = 'order-service';

// Service URLs for inter-service communication
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// In-memory data store
let orders = [
  { id: '1', userId: '1', products: [{ productId: '1', quantity: 2 }], total: 59.98, status: 'completed', createdAt: new Date().toISOString() },
  { id: '2', userId: '2', products: [{ productId: '2', quantity: 1 }, { productId: '3', quantity: 1 }], total: 135.98, status: 'processing', createdAt: new Date().toISOString() }
];

let isReady = false;

setTimeout(() => {
  isReady = true;
  console.log(`[${SERVICE_NAME}] Service is ready`);
}, 2000);

// ---- Helper: HTTP GET request ----
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          reject(new Error(`Failed to parse response from ${url}`));
        }
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out`));
    });
  });
}

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

// GET /api/orders - List all orders
app.get('/api/orders', (req, res) => {
  let result = [...orders];

  // Optional filter by userId
  if (req.query.userId) {
    result = result.filter(o => o.userId === req.query.userId);
  }

  // Optional filter by status
  if (req.query.status) {
    result = result.filter(o => o.status === req.query.status);
  }

  res.status(200).json({
    success: true,
    count: result.length,
    data: result
  });
});

// GET /api/orders/:id - Get order by ID
app.get('/api/orders/:id', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) {
    return res.status(404).json({ success: false, error: 'Order not found' });
  }
  res.status(200).json({ success: true, data: order });
});

// POST /api/orders - Create order (validates user and products)
app.post('/api/orders', async (req, res) => {
  try {
    const { userId, products: orderProducts } = req.body;

    if (!userId || !orderProducts || !Array.isArray(orderProducts) || orderProducts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'userId and products array are required'
      });
    }

    // Validate user exists
    try {
      const userResponse = await httpGet(`${USER_SERVICE_URL}/api/users/${userId}`);
      if (userResponse.statusCode !== 200) {
        return res.status(404).json({ success: false, error: `User ${userId} not found` });
      }
    } catch (err) {
      console.error(`[${SERVICE_NAME}] User service error:`, err.message);
      return res.status(503).json({
        success: false,
        error: 'User service unavailable. Please try again later.'
      });
    }

    // Validate products and calculate total
    let total = 0;
    for (const item of orderProducts) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Each product must have a valid productId and positive quantity'
        });
      }

      try {
        const productResponse = await httpGet(`${PRODUCT_SERVICE_URL}/api/products/${item.productId}`);
        if (productResponse.statusCode !== 200) {
          return res.status(404).json({ success: false, error: `Product ${item.productId} not found` });
        }
        total += productResponse.data.data.price * item.quantity;
      } catch (err) {
        console.error(`[${SERVICE_NAME}] Product service error:`, err.message);
        return res.status(503).json({
          success: false,
          error: 'Product service unavailable. Please try again later.'
        });
      }
    }

    const newOrder = {
      id: uuidv4(),
      userId,
      products: orderProducts,
      total: Math.round(total * 100) / 100,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    orders.push(newOrder);
    res.status(201).json({ success: true, data: newOrder });

  } catch (err) {
    console.error(`[${SERVICE_NAME}] Create order error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to create order' });
  }
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
  console.log(`[${SERVICE_NAME}] User Service URL: ${USER_SERVICE_URL}`);
  console.log(`[${SERVICE_NAME}] Product Service URL: ${PRODUCT_SERVICE_URL}`);
});

module.exports = app;