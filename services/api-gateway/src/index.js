const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const SERVICE_NAME = 'api-gateway';

// Upstream service URLs
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const PRODUCT_SERVICE_URL = process.env.PRODUCT_SERVICE_URL || 'http://localhost:3002';
const ORDER_SERVICE_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:3003';

// Middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));

let isReady = false;

setTimeout(() => {
  isReady = true;
  console.log(`[${SERVICE_NAME}] Gateway is ready`);
}, 2000);

// ---- Health & Readiness ----
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: SERVICE_NAME,
    timestamp: new Date().toISOString(),
    upstreams: {
      userService: USER_SERVICE_URL,
      productService: PRODUCT_SERVICE_URL,
      orderService: ORDER_SERVICE_URL
    }
  });
});

app.get('/ready', (req, res) => {
  if (isReady) {
    res.status(200).json({ status: 'ready', service: SERVICE_NAME });
  } else {
    res.status(503).json({ status: 'not ready', service: SERVICE_NAME });
  }
});

// ---- Root endpoint ----
app.get('/', (req, res) => {
  res.status(200).json({
    service: SERVICE_NAME,
    version: '1.0.0',
    message: 'EKS E-Commerce API Gateway',
    endpoints: {
      users: '/api/users',
      products: '/api/products',
      orders: '/api/orders',
      health: '/health',
      ready: '/ready'
    }
  });
});

// ---- Proxy Configuration ----
const proxyOptions = (target, serviceName) => ({
  target,
  changeOrigin: true,
  logLevel: 'warn',
  onError: (err, req, res) => {
    console.error(`[${SERVICE_NAME}] Proxy error for ${serviceName}:`, err.message);
    res.status(503).json({
      success: false,
      error: `${serviceName} is unavailable`,
      message: 'Please try again later'
    });
  },
  onProxyReq: (proxyReq, req, res) => {
    proxyReq.setHeader('X-Forwarded-By', SERVICE_NAME);
    proxyReq.setHeader('X-Request-Start', Date.now().toString());
  }
});

// ---- Proxy Routes ----
app.use('/api/users', createProxyMiddleware(proxyOptions(USER_SERVICE_URL, 'user-service')));
app.use('/api/products', createProxyMiddleware(proxyOptions(PRODUCT_SERVICE_URL, 'product-service')));
app.use('/api/orders', createProxyMiddleware(proxyOptions(ORDER_SERVICE_URL, 'order-service')));

// ---- 404 Handler ----
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/api/users', '/api/products', '/api/orders', '/health', '/ready']
  });
});

// ---- Error Handler ----
app.use((err, req, res, next) => {
  console.error(`[${SERVICE_NAME}] Error:`, err.message);
  res.status(500).json({ success: false, error: 'Internal gateway error' });
});

// ---- Start Server ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${SERVICE_NAME}] Running on port ${PORT}`);
  console.log(`[${SERVICE_NAME}] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[${SERVICE_NAME}] Routing:`);
  console.log(`  /api/users    -> ${USER_SERVICE_URL}`);
  console.log(`  /api/products -> ${PRODUCT_SERVICE_URL}`);
  console.log(`  /api/orders   -> ${ORDER_SERVICE_URL}`);
});

module.exports = app;