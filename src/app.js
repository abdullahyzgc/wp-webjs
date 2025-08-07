const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

// Import custom modules
const logger = require('./utils/logger');
const errorHandler = require('./middleware/errorHandler');
const WhatsAppManager = require('./services/WhatsAppManager');

// Import routes
const whatsappRoutes = require('./controllers/whatsappController');

class WhatsAppAPI {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = socketIo(this.server, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        this.port = process.env.PORT || 3001;
        this.whatsappManager = new WhatsAppManager(this.io);
        
        this.initializeMiddleware();
        this.initializeRoutes();
        this.initializeErrorHandling();
        this.initializeSocketEvents();
    }

    initializeMiddleware() {
        // Security middleware
        this.app.use(helmet());
        
        // CORS
        this.app.use(cors());
        
        // Logging
        this.app.use(morgan('combined', { stream: { write: message => logger.info(message.trim()) } }));
        
        // Body parsing
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));
        
        // Static files
        this.app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
        
        // Make WhatsApp manager available to routes
        this.app.use((req, res, next) => {
            req.whatsappManager = this.whatsappManager;
            next();
        });
    }

    initializeRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: true, 
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
            });
        });

        // API routes
        this.app.use('/api/whatsapp', whatsappRoutes);
        
        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({ 
                error: 'Endpoint not found',
                message: `${req.method} ${req.originalUrl} is not a valid endpoint`
            });
        });
    }

    initializeErrorHandling() {
        this.app.use(errorHandler);
    }

    initializeSocketEvents() {
        this.io.on('connection', (socket) => {
            logger.info(`Client connected: ${socket.id}`);
            
            socket.on('disconnect', () => {
                logger.info(`Client disconnected: ${socket.id}`);
            });
            
            // Join instance room for specific updates
            socket.on('join-instance', (instanceId) => {
                socket.join(`instance-${instanceId}`);
                logger.info(`Client ${socket.id} joined instance room: ${instanceId}`);
            });
            
            // Leave instance room
            socket.on('leave-instance', (instanceId) => {
                socket.leave(`instance-${instanceId}`);
                logger.info(`Client ${socket.id} left instance room: ${instanceId}`);
            });
        });
    }

    start() {
        this.server.listen(this.port, () => {
            logger.info(`WhatsApp API Server started on port ${this.port}`);
            logger.info(`Health check available at: http://localhost:${this.port}/health`);
            logger.info(`WebSocket server running on the same port`);
        });

        // Graceful shutdown
        process.on('SIGTERM', () => this.shutdown());
        process.on('SIGINT', () => this.shutdown());
    }

    async shutdown() {
        console.log('\n🛑 Graceful shutdown başlatılıyor...');
        logger.info('Shutting down server...');

        try {
            // Stop health monitoring
            this.whatsappManager.stopHealthMonitoring();

            // Close all WhatsApp instances
            await this.whatsappManager.cleanup();

            // Close server
            this.server.close(() => {
                console.log('✅ Server kapatıldı');
                logger.info('Server closed successfully');
                process.exit(0);
            });
        } catch (error) {
            console.error('❌ Shutdown sırasında hata:', error.message);
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    }
}

// Start the application
const app = new WhatsAppAPI();
app.start();

module.exports = WhatsAppAPI;
