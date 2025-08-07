const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Joi = require('joi');
const { AppError } = require('../middleware/errorHandler');
const logger = require('../utils/logger');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../../uploads');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow all file types for WhatsApp media
        cb(null, true);
    }
});

// Validation schemas
const createInstanceSchema = Joi.object({
    instanceId: Joi.string().optional()
});

const sendMessageSchema = Joi.object({
    to: Joi.string().required(),
    message: Joi.string().required()
});

const sendMediaSchema = Joi.object({
    to: Joi.string().required(),
    caption: Joi.string().optional().allow('')
});

const checkNumberSchema = Joi.object({
    number: Joi.string().required()
});

const getChatMessagesSchema = Joi.object({
    chatId: Joi.string().required(),
    limit: Joi.number().integer().min(1).max(1000).optional().default(50)
});

const getContactProfileSchema = Joi.object({
    contactId: Joi.string().required()
});

const getMultipleContactProfilesSchema = Joi.object({
    contactIds: Joi.array().items(Joi.string()).min(1).max(50).required()
});

const getGroupInfoSchema = Joi.object({
    groupId: Joi.string().required()
});

const getContactAboutSchema = Joi.object({
    contactId: Joi.string().required()
});

// Middleware to validate instance exists
const validateInstance = async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const status = req.whatsappManager.getInstanceStatus(instanceId);
        
        if (status.error) {
            return res.status(404).json({
                success: false,
                error: 'Instance not found',
                instanceId
            });
        }
        
        req.instanceStatus = status;
        next();
    } catch (error) {
        next(error);
    }
};

// Routes

/**
 * GET /api/whatsapp/instances
 * Get all instances status
 */
router.get('/instances', (req, res) => {
    try {
        const instances = req.whatsappManager.getInstancesStatus();
        res.json({
            success: true,
            instances,
            count: instances.length
        });
    } catch (error) {
        logger.error('Error getting instances:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get instances'
        });
    }
});

/**
 * POST /api/whatsapp/instances
 * Create new WhatsApp instance
 */
router.post('/instances', async (req, res, next) => {
    try {
        const { error, value } = createInstanceSchema.validate(req.body);
        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        const result = await req.whatsappManager.createInstance(value.instanceId);
        res.status(201).json({
            success: true,
            ...result
        });
    } catch (error) {
        if (error.message.includes('already exists')) {
            return res.status(409).json({
                success: false,
                error: error.message
            });
        }
        next(error);
    }
});

/**
 * GET /api/whatsapp/instances/:instanceId
 * Get specific instance status
 */
router.get('/instances/:instanceId', validateInstance, (req, res) => {
    res.json({
        success: true,
        instance: req.instanceStatus
    });
});

/**
 * POST /api/whatsapp/instances/:instanceId/initialize
 * Initialize WhatsApp instance
 */
router.post('/instances/:instanceId/initialize', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const result = await req.whatsappManager.initializeInstance(instanceId);
        
        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/reconnect
 * Force reconnect a disconnected instance
 */
router.post('/instances/:instanceId/reconnect', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;

        if (req.instanceStatus.status === 'ready') {
            return res.json({
                success: true,
                message: 'Instance is already connected',
                instanceId,
                status: 'ready'
            });
        }

        if (req.instanceStatus.status !== 'disconnected') {
            return res.status(400).json({
                success: false,
                error: `Instance is not disconnected. Current status: ${req.instanceStatus.status}`
            });
        }

        await req.whatsappManager.attemptAutoReconnection(instanceId);

        res.json({
            success: true,
            message: 'Reconnection attempt started',
            instanceId,
            status: 'reconnecting'
        });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /api/whatsapp/instances/:instanceId
 * Destroy WhatsApp instance
 */
router.delete('/instances/:instanceId', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const result = await req.whatsappManager.destroyInstance(instanceId);
        
        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/send-message
 * Send text message
 */
router.post('/instances/:instanceId/send-message', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = sendMessageSchema.validate(req.body);
        
        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.sendMessage(instanceId, value.to, value.message);
        
        res.json({
            success: true,
            instanceId,
            to: value.to,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/send-media
 * Send media message
 */
router.post('/instances/:instanceId/send-media', validateInstance, upload.single('media'), async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No media file provided'
            });
        }

        const { error, value } = sendMediaSchema.validate(req.body);
        if (error) {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            // Clean up uploaded file
            fs.unlinkSync(req.file.path);
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.sendMedia(instanceId, value.to, req.file.path, value.caption);
        
        // Clean up uploaded file after sending
        setTimeout(() => {
            if (fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }
        }, 5000);
        
        res.json({
            success: true,
            instanceId,
            to: value.to,
            fileName: req.file.originalname,
            ...result
        });
    } catch (error) {
        // Clean up uploaded file on error
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/check-number
 * Check if number is registered on WhatsApp
 */
router.post('/instances/:instanceId/check-number', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = checkNumberSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.checkNumber(instanceId, value.number);

        res.json({
            success: true,
            instanceId,
            number: value.number,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/whatsapp/instances/:instanceId/chats
 * Get all chats (contacts and groups)
 * Query params:
 *   - includeProfilePics=true/false (default: true)
 *   - limit=number (default: 50, max: 200)
 *   - offset=number (default: 0)
 */
router.get('/instances/:instanceId/chats', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const includeProfilePics = req.query.includeProfilePics !== 'false'; // Default true
        const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200
        const offset = Math.max(parseInt(req.query.offset) || 0, 0); // Min 0

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        // Set timeout for the entire request (30 seconds)
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Request timeout')), 30000);
        });

        const chatPromise = req.whatsappManager.getChats(instanceId, includeProfilePics, limit, offset);

        const result = await Promise.race([chatPromise, timeoutPromise]);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        if (error.message === 'Request timeout') {
            return res.status(408).json({
                success: false,
                error: 'Request timeout. Try with a smaller limit or without profile pictures.',
                suggestion: `Try: /chats?limit=10&includeProfilePics=false`
            });
        }
        next(error);
    }
});

/**
 * GET /api/whatsapp/instances/:instanceId/contacts
 * Get contacts only
 * Query params:
 *   - includeProfilePics=true/false (default: true)
 *   - limit=number (default: 50, max: 200)
 *   - offset=number (default: 0)
 */
router.get('/instances/:instanceId/contacts', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const includeProfilePics = req.query.includeProfilePics !== 'false'; // Default true
        const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200
        const offset = Math.max(parseInt(req.query.offset) || 0, 0); // Min 0

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getContacts(instanceId, includeProfilePics, limit, offset);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /api/whatsapp/instances/:instanceId/groups
 * Get groups only
 * Query params:
 *   - includeProfilePics=true/false (default: true)
 *   - limit=number (default: 50, max: 200)
 *   - offset=number (default: 0)
 */
router.get('/instances/:instanceId/groups', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const includeProfilePics = req.query.includeProfilePics !== 'false'; // Default true
        const limit = Math.min(parseInt(req.query.limit) || 50, 200); // Max 200
        const offset = Math.max(parseInt(req.query.offset) || 0, 0); // Min 0

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getGroups(instanceId, includeProfilePics, limit, offset);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/chat-messages
 * Get messages from a specific chat
 */
router.post('/instances/:instanceId/chat-messages', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = getChatMessagesSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getChatMessages(instanceId, value.chatId, value.limit);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/contact-profile
 * Get contact profile information
 */
router.post('/instances/:instanceId/contact-profile', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = getContactProfileSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getContactProfile(instanceId, value.contactId);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/multiple-contact-profiles
 * Get multiple contacts profile information
 */
router.post('/instances/:instanceId/multiple-contact-profiles', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = getMultipleContactProfilesSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getMultipleContactProfiles(instanceId, value.contactIds);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/group-info
 * Get group information and participants
 */
router.post('/instances/:instanceId/group-info', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = getGroupInfoSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getGroupInfo(instanceId, value.groupId);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /api/whatsapp/instances/:instanceId/contact-about
 * Get contact's about/status message
 */
router.post('/instances/:instanceId/contact-about', validateInstance, async (req, res, next) => {
    try {
        const { instanceId } = req.params;
        const { error, value } = getContactAboutSchema.validate(req.body);

        if (error) {
            return res.status(400).json({
                success: false,
                error: error.details[0].message
            });
        }

        if (req.instanceStatus.status !== 'ready') {
            return res.status(400).json({
                success: false,
                error: `Instance is not ready. Current status: ${req.instanceStatus.status}`
            });
        }

        const result = await req.whatsappManager.getContactAbout(instanceId, value.contactId);

        res.json({
            success: true,
            instanceId,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
