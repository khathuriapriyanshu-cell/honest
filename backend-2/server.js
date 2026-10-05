/**
 * HONEST Backend 2 (KBAI) - Primary Server Entry Point
 * 
 * Express + SQLite REST API Service
 */

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { getDatabase } = require('./database');
const apiRoutes = require('./routes/apiRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for frontend clients (all origins supported during local development)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize persistent SQLite database
const db = getDatabase();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'HONEST Backend 2 (KBAI)',
    database: 'SQLite (node:sqlite)',
    timestamp: new Date().toISOString()
  });
});

// Root info
app.get('/', (req, res) => {
  res.json({
    name: 'HONEST REST API',
    version: '1.0.0',
    tagline: 'BE HONEST WITH YOURSELF.',
    apiRoot: '/api'
  });
});

// Mount API routes
app.use('/api', apiRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Endpoint ${req.method} ${req.url} does not exist.`
    }
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[HONEST Backend Error]', err);
  const status = err.status || 500;
  res.status(status).json({
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected error occurred.'
    }
  });
});

// Start listening if run directly
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`===============================================`);
    console.log(`HONEST Backend 2 (KBAI) running on port ${PORT}`);
    console.log(`API URL: http://localhost:${PORT}/api`);
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`===============================================`);
  });
}

module.exports = app;
