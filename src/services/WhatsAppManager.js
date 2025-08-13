const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

class WhatsAppManager {
    constructor(io) {
        this.io = io;
        this.instances = new Map();
        this.sessionsPath = path.join(__dirname, '../../sessions');
        this.healthCheckInterval = null;
        this.reconnectionInterval = null;
        this.profilePicCache = new Map(); // Cache for profile pictures
        this.cacheExpiry = 30 * 60 * 1000; // 30 minutes cache
        this.maxReconnectAttempts = 8; // Daha fazla deneme
        this.reconnectDelay = 5000; // 5 saniye (çok daha hızlı)

        // Create sessions directory if it doesn't exist
        if (!fs.existsSync(this.sessionsPath)) {
            fs.mkdirSync(this.sessionsPath, { recursive: true });
        }

        // Auto-recover existing sessions on startup
        this.recoverExistingSessions();

        // Start health monitoring
        this.startHealthMonitoring();

        // Start auto-reconnection monitoring
        this.startAutoReconnection();
    }

    /**
     * Recover existing sessions on startup
     */
    async recoverExistingSessions() {
        try {
            console.log('\n🔄 Mevcut session\'lar kontrol ediliyor...');

            if (!fs.existsSync(this.sessionsPath)) {
                console.log('📁 Session klasörü bulunamadı, yeni başlangıç yapılıyor.\n');
                return;
            }

            const sessionDirs = fs.readdirSync(this.sessionsPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            if (sessionDirs.length === 0) {
                console.log('📂 Mevcut session bulunamadı.\n');
                return;
            }

            console.log(`📋 ${sessionDirs.length} adet session bulundu: ${sessionDirs.join(', ')}`);
            console.log('⚡ Session\'lar otomatik olarak yükleniyor...\n');

            for (const instanceId of sessionDirs) {
                try {
                    await this.recoverInstance(instanceId);
                } catch (error) {
                    logger.error(`Error recovering instance ${instanceId}:`, error);
                    console.log(`❌ Instance ${instanceId} yüklenirken hata oluştu: ${error.message}`);
                }
            }

            console.log('✅ Session recovery tamamlandı!\n');
        } catch (error) {
            logger.error('Error during session recovery:', error);
            console.log('❌ Session recovery sırasında hata oluştu:', error.message, '\n');
        }
    }

    /**
     * Check if session has valid authentication data
     * @param {string} sessionPath - Path to session directory
     * @returns {boolean} True if session has auth data
     */
    hasValidSession(sessionPath) {
        try {
            if (!fs.existsSync(sessionPath)) {
                return false;
            }

            // WhatsApp Web session structure: sessionPath/session-{instanceId}/Default/
            const sessionDirs = fs.readdirSync(sessionPath, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('session-'))
                .map(dirent => dirent.name);

            if (sessionDirs.length === 0) {
                return false;
            }

            const actualSessionPath = path.join(sessionPath, sessionDirs[0], 'Default');

            if (!fs.existsSync(actualSessionPath)) {
                return false;
            }

            // Check for WhatsApp Web specific authentication indicators
            const checks = [
                // IndexedDB contains WhatsApp authentication data
                path.join(actualSessionPath, 'IndexedDB', 'https_web.whatsapp.com_0.indexeddb.leveldb'),
                // Local Storage contains session data
                path.join(actualSessionPath, 'Local Storage', 'leveldb'),
                // Session Storage for temporary session data
                path.join(actualSessionPath, 'Session Storage'),
                // Cookies for authentication
                path.join(actualSessionPath, 'Cookies')
            ];

            // Check if IndexedDB has substantial data (indicates authentication)
            const indexedDBPath = checks[0];
            if (fs.existsSync(indexedDBPath)) {
                const indexedDBFiles = fs.readdirSync(indexedDBPath);
                // Look for .ldb files which contain actual data
                const hasDataFiles = indexedDBFiles.some(file => file.endsWith('.ldb'));
                if (hasDataFiles) {
                    console.log(`✅ Instance ${path.basename(sessionPath)} has valid IndexedDB authentication data`);
                    return true;
                }
            }

            // Check Local Storage for authentication data
            const localStoragePath = checks[1];
            if (fs.existsSync(localStoragePath)) {
                const localStorageFiles = fs.readdirSync(localStoragePath);
                const hasLogFiles = localStorageFiles.some(file => file.endsWith('.log') && fs.statSync(path.join(localStoragePath, file)).size > 0);
                if (hasLogFiles) {
                    console.log(`✅ Instance ${path.basename(sessionPath)} has valid Local Storage authentication data`);
                    return true;
                }
            }

            // Check if Cookies file exists and has content
            const cookiesPath = checks[3];
            if (fs.existsSync(cookiesPath)) {
                const cookiesStats = fs.statSync(cookiesPath);
                if (cookiesStats.size > 100) { // Cookies file should have substantial content
                    console.log(`✅ Instance ${path.basename(sessionPath)} has valid Cookies authentication data`);
                    return true;
                }
            }

            console.log(`❌ Instance ${path.basename(sessionPath)} does not have valid authentication data`);
            return false;

        } catch (error) {
            logger.error(`Error checking session validity for ${sessionPath}:`, error);
            console.log(`❌ Error checking session validity for ${path.basename(sessionPath)}: ${error.message}`);
            return false;
        }
    }

    /**
     * Recover a specific instance
     * @param {string} instanceId - Instance identifier
     */
    async recoverInstance(instanceId) {
        try {
            const sessionPath = path.join(this.sessionsPath, instanceId);

            // Check if session directory exists and has content
            if (!fs.existsSync(sessionPath)) {
                console.log(`⚠️ Instance ${instanceId} session klasörü bulunamadı`);
                return;
            }

            const hasValidAuth = this.hasValidSession(sessionPath);

            if (hasValidAuth) {
                console.log(`🔄 Instance ${instanceId} yükleniyor... (Authenticated session bulundu)`);
                console.log(`🎉 QR kod atlanıyor, direkt bağlantı kuruluyor...`);
            } else {
                console.log(`🔄 Instance ${instanceId} yükleniyor... (Yeni authentication gerekli)`);
            }

            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: instanceId,
                    dataPath: sessionPath
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-background-networking',
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-ipc-flooding-protection',
                        '--run-all-compositor-stages-before-draw',
                        '--disable-extensions',
                        '--aggressive-cache-discard'
                    ]
                }
            });

            const instanceData = {
                id: instanceId,
                client,
                status: hasValidAuth ? 'authenticating' : 'recovering',
                qr: null,
                info: null,
                createdAt: new Date(),
                lastActivity: new Date(),
                isRecovered: true,
                hasValidAuth: hasValidAuth,
                skipQR: hasValidAuth, // QR kodunu atla flag'i (başlangıçta dosya kontrolüne göre)
                authenticationAttempted: false // Authentication denenip denenmediğini takip et
            };

            this.instances.set(instanceId, instanceData);
            this.setupClientEvents(instanceId, client);

            // Initialize the client
            await client.initialize();

            if (hasValidAuth) {
                console.log(`✅ Instance ${instanceId} authenticated session ile yüklendi`);
            } else {
                console.log(`✅ Instance ${instanceId} yüklendi (QR kod gerekli)`);
            }

            logger.info(`Instance ${instanceId} recovered successfully`);

        } catch (error) {
            logger.error(`Error recovering instance ${instanceId}:`, error);
            console.log(`❌ Instance ${instanceId} yüklenirken hata: ${error.message}`);

            // Clean up failed recovery
            if (this.instances.has(instanceId)) {
                this.instances.delete(instanceId);
            }
            throw error;
        }
    }

    /**
     * Create a new WhatsApp instance
     * @param {string} instanceId - Unique identifier for the instance
     * @returns {Promise<Object>} Instance information
     */
    async createInstance(instanceId = null) {
        try {
            const id = instanceId || uuidv4();
            
            if (this.instances.has(id)) {
                throw new Error(`Instance ${id} already exists`);
            }

            const sessionPath = path.join(this.sessionsPath, id);
            
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: id,
                    dataPath: sessionPath
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-background-networking',
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-ipc-flooding-protection',
                        '--run-all-compositor-stages-before-draw',
                        '--disable-extensions',
                        '--aggressive-cache-discard'
                    ]
                }
            });

            const instanceData = {
                id,
                client,
                status: 'initializing',
                qr: null,
                info: null,
                createdAt: new Date(),
                lastActivity: new Date(),
                isRecovered: false,
                hasValidAuth: false,
                skipQR: false
            };

            this.instances.set(id, instanceData);
            this.setupClientEvents(id, client);

            // Terminal'de instance oluşturma mesajı
            console.log(`\n🚀 WhatsApp Instance oluşturuldu: ${id}`);
            console.log(`📱 Durum: Başlatılmayı bekliyor`);
            console.log(`💡 Instance'ı başlatmak için initialize endpoint'ini kullanın\n`);

            logger.info(`WhatsApp instance ${id} created`);

            return {
                instanceId: id,
                status: 'initializing',
                message: 'Instance created successfully'
            };
        } catch (error) {
            logger.error(`Error creating instance: ${error.message}`);
            throw error;
        }
    }

    /**
     * Setup event listeners for WhatsApp client
     * @param {string} instanceId - Instance identifier
     * @param {Client} client - WhatsApp client
     */
    setupClientEvents(instanceId, client) {
        const instance = this.instances.get(instanceId);

        client.on('qr', async (qr) => {
            try {
                // QR event tetiklenmişse client authenticated değil demektir
                // Hızlı kontrol: sadece skipQR flag'i varsa ve bu ilk QR değilse kontrol et
                if (instance.skipQR && instance.hasValidAuth) {
                    console.log(`\n⚠️ Instance ${instanceId} için beklenmeyen QR kod eventi!`);
                    console.log('📂 Session dosyaları mevcut ama client bağlı değil');
                    console.log('🔄 Session geçersiz, QR kod gösteriliyor...\n');
                    
                    // skipQR flag'ini iptal et çünkü gerçekte authentication gerekli
                    instance.skipQR = false;
                    instance.hasValidAuth = false;
                    instance.status = 'qr_required';
                    
                    logger.warn(`QR event triggered for supposedly authenticated instance ${instanceId} - session invalid`);
                }

                // QR kod işlemlerini paralel başlat - optimize edilmiş ayarlarla
                const qrDataURLPromise = qrcode.toDataURL(qr, {
                    width: 256,  // Küçük boyut = hızlı oluşturma
                    margin: 1,   // Minimum margin
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    },
                    errorCorrectionLevel: 'L'  // Düşük hata düzeltme = hızlı oluşturma
                });
                const qrTerminalPromise = qrcode.toString(qr, { 
                    type: 'terminal', 
                    small: true,
                    errorCorrectionLevel: 'L'
                });
                
                // Instance durumunu hemen güncelle
                instance.status = 'qr_ready';
                
                // Terminal mesajını hemen göster
                if (instance.isRecovered && !instance.hasValidAuth) {
                    console.log(`\n🔗 Recovered Instance ${instanceId} için QR Code:`);
                } else if (instance.isRecovered) {
                    console.log(`\n⚠️ Instance ${instanceId} için yeni QR kod oluşturuldu!`);
                } else {
                    console.log(`\n🔗 QR Code for instance ${instanceId}:`);
                }
                console.log('📱 WhatsApp uygulamanızla aşağıdaki QR kodu tarayın:\n');

                // QR kod işlemlerinin tamamlanmasını bekle
                const [qrDataURL, qrTerminal] = await Promise.all([qrDataURLPromise, qrTerminalPromise]);
                
                instance.qr = qrDataURL;
                
                // Terminal'de QR kod göster
                console.log(qrTerminal);
                console.log(`\n✅ Instance ${instanceId} QR kodu hazır!`);
                console.log('🔄 QR kod tarandıktan sonra bağlantı otomatik olarak kurulacak...\n');

                logger.info(`QR code generated for instance ${instanceId}`);

                // Socket emit'leri paralel yap
                const emitPromises = [
                    // Emit QR code to specific instance room
                    this.io.to(`instance-${instanceId}`).emit('qr', {
                        instanceId,
                        qr: qrDataURL,
                        timestamp: new Date(),
                        isRecovered: instance.isRecovered || false
                    }),
                    
                    // Also emit to general room for monitoring
                    this.io.emit('instance_qr', {
                        instanceId,
                        qr: qrDataURL,
                        timestamp: new Date(),
                        isRecovered: instance.isRecovered || false
                    })
                ];
                
                // Emit'leri beklemeden devam et (fire and forget)
                Promise.all(emitPromises).catch(error => {
                    logger.error(`Error emitting QR for instance ${instanceId}:`, error);
                });
            } catch (error) {
                logger.error(`Error generating QR for instance ${instanceId}:`, error);
            }
        });

        // Authentication başarılı olduğunda
        client.on('authenticated', () => {
            console.log(`\n🔐 Instance ${instanceId} authentication başarılı!`);
            instance.hasValidAuth = true;
            instance.skipQR = true;
            instance.status = 'authenticated';
            logger.info(`Instance ${instanceId} authenticated successfully`);
        });

        // Authentication başarısız olduğunda
        client.on('auth_failure', (msg) => {
            console.log(`\n❌ Instance ${instanceId} authentication başarısız: ${msg}`);
            instance.hasValidAuth = false;
            instance.skipQR = false;
            instance.status = 'auth_failed';
            logger.warn(`Instance ${instanceId} authentication failed: ${msg}`);
            
            // Emit authentication failure
            this.io.to(`instance-${instanceId}`).emit('auth_failure', {
                instanceId,
                message: msg,
                timestamp: new Date()
            });
        });

        // Session kaybolduğunda
        client.on('disconnected', (reason) => {
            console.log(`\n🔌 Instance ${instanceId} bağlantısı kesildi: ${reason}`);
            instance.hasValidAuth = false;
            instance.skipQR = false;
            instance.status = 'disconnected';
            logger.warn(`Instance ${instanceId} disconnected: ${reason}`);
            
            // Keep-alive'ı durdur
            this.stopKeepAlive(instanceId);
            
            // Emit disconnection
            this.io.to(`instance-${instanceId}`).emit('disconnected', {
                instanceId,
                reason,
                timestamp: new Date()
            });
        });

        client.on('ready', () => {
            instance.status = 'ready';
            instance.qr = null;
            instance.info = client.info;
            instance.lastActivity = new Date();
            
            // Ready olduğunda authentication kesinlikle başarılı demektir
            instance.hasValidAuth = true;
            instance.skipQR = true;

            // Terminal'de bağlantı başarılı mesajı
            if (instance.isRecovered && instance.hasValidAuth) {
                console.log(`\n🎉 Instance ${instanceId} authenticated session ile otomatik bağlandı!`);
                console.log(`👤 Kullanıcı: ${client.info.pushname || 'Bilinmiyor'}`);
                console.log(`📱 Telefon: ${client.info.wid.user}`);
                console.log(`✅ Durum: Mesaj göndermeye hazır (Auto-Recovered)\n`);
            } else if (instance.isRecovered) {
                console.log(`\n🔄 Instance ${instanceId} QR kod ile yeniden bağlandı!`);
                console.log(`👤 Kullanıcı: ${client.info.pushname || 'Bilinmiyor'}`);
                console.log(`📱 Telefon: ${client.info.wid.user}`);
                console.log(`✅ Durum: Mesaj göndermeye hazır (Re-authenticated)\n`);
            } else {
                console.log(`\n🎉 WhatsApp Instance ${instanceId} başarıyla bağlandı!`);
                console.log(`👤 Kullanıcı: ${client.info.pushname || 'Bilinmiyor'}`);
                console.log(`📱 Telefon: ${client.info.wid.user}`);
                console.log(`✅ Durum: Mesaj göndermeye hazır\n`);
            }

            logger.info(`WhatsApp instance ${instanceId} is ready`);

            this.io.to(`instance-${instanceId}`).emit('ready', {
                instanceId,
                info: client.info,
                timestamp: new Date(),
                isRecovered: instance.isRecovered || false,
                hasValidAuth: instance.hasValidAuth || false
            });

            this.io.emit('instance_ready', {
                instanceId,
                info: client.info,
                timestamp: new Date(),
                isRecovered: instance.isRecovered || false,
                hasValidAuth: instance.hasValidAuth || false
            });

            // Keep-alive mekanizması başlat
            this.startKeepAlive(instanceId);
        });

        client.on('authenticated', () => {
            instance.status = 'authenticated';

            // Terminal'de kimlik doğrulama mesajı
            console.log(`\n🔐 Instance ${instanceId} kimlik doğrulaması başarılı!`);
            console.log(`⏳ WhatsApp bağlantısı kuruluyor...\n`);

            logger.info(`WhatsApp instance ${instanceId} authenticated`);

            this.io.to(`instance-${instanceId}`).emit('authenticated', {
                instanceId,
                timestamp: new Date()
            });
        });

        client.on('auth_failure', (msg) => {
            instance.status = 'auth_failure';

            // Terminal'de kimlik doğrulama hatası
            console.log(`\n❌ Instance ${instanceId} kimlik doğrulama hatası!`);
            console.log(`🔴 Hata: ${msg}`);
            console.log(`🔄 Lütfen yeni bir QR kod oluşturun\n`);

            logger.error(`Authentication failed for instance ${instanceId}: ${msg}`);

            this.io.to(`instance-${instanceId}`).emit('auth_failure', {
                instanceId,
                message: msg,
                timestamp: new Date()
            });
        });

        client.on('disconnected', (reason) => {
            instance.status = 'disconnected';
            instance.reconnectAttempts = 0; // Reset reconnect attempts

            // Terminal'de bağlantı kesilme mesajı
            console.log(`\n⚠️ Instance ${instanceId} bağlantısı kesildi!`);
            console.log(`📱 Sebep: ${reason}`);

            // Check if we have valid auth for auto-reconnection
            if (instance.hasValidAuth) {
                console.log(`🔄 Otomatik yeniden bağlanma 60 saniye içinde başlayacak...`);
                console.log(`💡 Manuel yeniden bağlanma için initialize endpoint'ini kullanabilirsiniz\n`);
            } else {
                console.log(`🔄 Yeniden bağlanmak için instance'ı yeniden başlatın\n`);
            }

            logger.warn(`WhatsApp instance ${instanceId} disconnected: ${reason}`);

            this.io.to(`instance-${instanceId}`).emit('disconnected', {
                instanceId,
                reason,
                timestamp: new Date(),
                autoReconnectEnabled: instance.hasValidAuth
            });

            this.io.emit('instance_status_changed', {
                instanceId,
                status: 'disconnected',
                reason,
                autoReconnectEnabled: instance.hasValidAuth,
                timestamp: new Date()
            });
        });

        // Activity tracking - her mesajda lastActivity güncelle
        client.on('message', (message) => {
            // Son aktivite zamanını güncelle (bağlantının aktif olduğunu gösterir)
            instance.lastActivity = new Date();
            
            this.io.to(`instance-${instanceId}`).emit('message', {
                instanceId,
                message: {
                    id: message.id._serialized,
                    from: message.from,
                    to: message.to,
                    body: message.body,
                    type: message.type,
                    timestamp: message.timestamp,
                    fromMe: message.fromMe
                },
                timestamp: new Date()
            });
        });

        client.on('message_create', (message) => {
            // Giden mesajlarda da activity güncelle
            instance.lastActivity = new Date();
            
            this.io.to(`instance-${instanceId}`).emit('message_create', {
                instanceId,
                message: {
                    id: message.id._serialized,
                    from: message.from,
                    to: message.to,
                    body: message.body,
                    type: message.type,
                    timestamp: message.timestamp,
                    fromMe: message.fromMe
                },
                timestamp: new Date()
            });
        });
    }

    /**
     * Initialize WhatsApp client
     * @param {string} instanceId - Instance identifier
     * @returns {Promise<Object>} Initialization result
     */
    async initializeInstance(instanceId) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status === 'ready') {
                return {
                    success: true,
                    message: 'Instance already ready',
                    status: instance.status
                };
            }

            // Terminal'de başlatma mesajı
            console.log(`\n⚡ Instance ${instanceId} başlatılıyor...`);
            console.log(`🔄 WhatsApp Web bağlantısı kuruluyor...`);
            console.log(`⏳ QR kod oluşturulması bekleniyor...\n`);

            await instance.client.initialize();

            return {
                success: true,
                message: 'Instance initialization started',
                status: instance.status
            };
        } catch (error) {
            logger.error(`Error initializing instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Send text message
     * @param {string} instanceId - Instance identifier
     * @param {string} to - Recipient number
     * @param {string} message - Message text
     * @returns {Promise<Object>} Send result
     */
    async sendMessage(instanceId, to, message) {
        const operation = async () => {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const chatId = to.includes('@') ? to : `${to}@c.us`;
            const result = await instance.client.sendMessage(chatId, message);

            instance.lastActivity = new Date();

            // Terminal'de mesaj gönderme bilgisi
            console.log(`\n📤 Mesaj gönderildi!`);
            console.log(`📱 Instance: ${instanceId}`);
            console.log(`👤 Alıcı: ${to}`);
            console.log(`💬 Mesaj: ${message.length > 50 ? message.substring(0, 50) + '...' : message}`);
            console.log(`🆔 Mesaj ID: ${result.id._serialized}\n`);

            logger.info(`Message sent from instance ${instanceId} to ${to}`);

            return {
                success: true,
                messageId: result.id._serialized,
                timestamp: result.timestamp
            };
        };

        try {
            return await this.executeWithRecovery(instanceId, operation, 'sendMessage');
        } catch (error) {
            logger.error(`Error sending message from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Send media message
     * @param {string} instanceId - Instance identifier
     * @param {string} to - Recipient number
     * @param {string} mediaPath - Path to media file
     * @param {string} caption - Optional caption
     * @returns {Promise<Object>} Send result
     */
    async sendMedia(instanceId, to, mediaPath, caption = '') {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const media = MessageMedia.fromFilePath(mediaPath);
            const chatId = to.includes('@') ? to : `${to}@c.us`;

            const result = await instance.client.sendMessage(chatId, media, { caption });

            instance.lastActivity = new Date();

            // Terminal'de medya gönderme bilgisi
            console.log(`\n📎 Medya gönderildi!`);
            console.log(`📱 Instance: ${instanceId}`);
            console.log(`👤 Alıcı: ${to}`);
            console.log(`📁 Dosya: ${mediaPath.split('/').pop()}`);
            if (caption) console.log(`💬 Açıklama: ${caption}`);
            console.log(`🆔 Mesaj ID: ${result.id._serialized}\n`);

            logger.info(`Media sent from instance ${instanceId} to ${to}`);

            return {
                success: true,
                messageId: result.id._serialized,
                timestamp: result.timestamp
            };
        } catch (error) {
            logger.error(`Error sending media from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get instance status
     * @param {string} instanceId - Instance identifier
     * @returns {Object} Instance status
     */
    getInstanceStatus(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return { error: 'Instance not found' };
        }

        return {
            instanceId,
            status: instance.status,
            qr: instance.qr,
            info: instance.info,
            createdAt: instance.createdAt,
            lastActivity: instance.lastActivity,
            isRecovered: instance.isRecovered || false,
            hasValidAuth: instance.hasValidAuth || false
        };
    }

    /**
     * Get all instances status
     * @returns {Array} All instances status
     */
    getInstancesStatus() {
        const statuses = [];
        for (const [id, instance] of this.instances) {
            statuses.push({
                instanceId: id,
                status: instance.status,
                info: instance.info,
                createdAt: instance.createdAt,
                lastActivity: instance.lastActivity,
                isRecovered: instance.isRecovered || false,
                hasValidAuth: instance.hasValidAuth || false
            });
        }
        return statuses;
    }

    /**
     * Destroy instance
     * @param {string} instanceId - Instance identifier
     * @returns {Promise<Object>} Destroy result
     */
    async destroyInstance(instanceId) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            await instance.client.destroy();
            this.instances.delete(instanceId);

            // Clean up session files
            const sessionPath = path.join(this.sessionsPath, instanceId);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }

            // Terminal'de silme mesajı
            console.log(`\n🗑️ Instance silindi: ${instanceId}`);
            console.log(`🧹 Session dosyaları temizlendi`);
            console.log(`✅ İşlem tamamlandı\n`);

            logger.info(`Instance ${instanceId} destroyed`);

            this.io.emit('instance_destroyed', {
                instanceId,
                timestamp: new Date()
            });

            return {
                success: true,
                message: 'Instance destroyed successfully'
            };
        } catch (error) {
            logger.error(`Error destroying instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Destroy all instances
     * @returns {Promise<void>}
     */
    async destroyAllInstances() {
        const promises = [];
        for (const instanceId of this.instances.keys()) {
            promises.push(this.destroyInstance(instanceId));
        }
        await Promise.all(promises);
        logger.info('All instances destroyed');
    }

    /**
     * Check if number is registered on WhatsApp
     * @param {string} instanceId - Instance identifier
     * @param {string} number - Phone number to check
     * @returns {Promise<Object>} Check result
     */
    async checkNumber(instanceId, number) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const numberId = await instance.client.getNumberId(number);

            return {
                success: true,
                exists: !!numberId,
                numberId: numberId ? numberId._serialized : null
            };
        } catch (error) {
            logger.error(`Error checking number from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get all chats (contacts and groups) with profile pictures
     * @param {string} instanceId - Instance identifier
     * @param {boolean} includeProfilePics - Whether to include profile pictures (default: true)
     * @param {number} limit - Maximum number of chats to return (default: 50)
     * @param {number} offset - Number of chats to skip (default: 0)
     * @returns {Promise<Object>} Chats result
     */
    async getChats(instanceId, includeProfilePics = true, limit = 50, offset = 0) {
        const operation = async () => {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const allChats = await instance.client.getChats();

            // Sort chats by timestamp (most recent first)
            allChats.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            // Apply pagination
            const totalChats = allChats.length;
            const paginatedChats = allChats.slice(offset, offset + limit);

            const contacts = [];
            const groups = [];

            // First, collect paginated chat data without profile pictures
            paginatedChats.forEach(chat => {
                const chatData = {
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    isReadOnly: chat.isReadOnly,
                    unreadCount: chat.unreadCount,
                    timestamp: chat.timestamp,
                    profilePicUrl: null, // Will be filled later
                    lastMessage: chat.lastMessage ? {
                        id: chat.lastMessage.id._serialized,
                        body: chat.lastMessage.body,
                        type: chat.lastMessage.type,
                        timestamp: chat.lastMessage.timestamp,
                        fromMe: chat.lastMessage.fromMe,
                        author: chat.lastMessage.author
                    } : null
                };

                if (chat.isGroup) {
                    groups.push(chatData);
                } else {
                    contacts.push(chatData);
                }
            });

            // Get profile pictures in batches if requested
            if (includeProfilePics) {
                const allChatIds = [...contacts, ...groups].map(chat => chat.id);

                if (allChatIds.length > 0) {
                    // Determine batch size based on total count
                    const batchSize = allChatIds.length <= 10 ? 3 :
                                    allChatIds.length <= 20 ? 4 : 5;

                    // Get profile pictures in controlled batches
                    const profilePicMap = await this.getMultipleProfilePics(instanceId, allChatIds, batchSize);

                    // Update contacts with profile pictures
                    contacts.forEach(contact => {
                        contact.profilePicUrl = profilePicMap.get(contact.id) || null;
                    });

                    // Update groups with profile pictures
                    groups.forEach(group => {
                        group.profilePicUrl = profilePicMap.get(group.id) || null;
                    });

                    const successCount = Array.from(profilePicMap.values()).filter(url => url !== null).length;
                    console.log(`🖼️ Instance ${instanceId} - ${successCount}/${allChatIds.length} profil resmi başarıyla alındı`);
                } else {
                    console.log(`🖼️ Instance ${instanceId} - Profil resmi alınacak chat bulunamadı`);
                }
            }

            instance.lastActivity = new Date();

            const hasMore = (offset + limit) < totalChats;
            const nextOffset = hasMore ? offset + limit : null;

            console.log(`📋 Instance ${instanceId} - ${contacts.length} kişi, ${groups.length} grup bulundu (${offset + 1}-${offset + paginatedChats.length}/${totalChats})`);
            logger.info(`Chats retrieved for instance ${instanceId}: ${contacts.length} contacts, ${groups.length} groups (page ${Math.floor(offset/limit) + 1})`);

            return {
                success: true,
                contacts,
                groups,
                totalChats,
                contactsCount: contacts.length,
                groupsCount: groups.length,
                profilePicsIncluded: includeProfilePics,
                pagination: {
                    limit,
                    offset,
                    hasMore,
                    nextOffset,
                    currentPage: Math.floor(offset / limit) + 1,
                    totalPages: Math.ceil(totalChats / limit),
                    returnedCount: paginatedChats.length
                }
            };
        };

        try {
            return await this.executeWithRecovery(instanceId, operation, 'getChats');
        } catch (error) {
            logger.error(`Error getting chats from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get contacts only with profile pictures
     * @param {string} instanceId - Instance identifier
     * @param {boolean} includeProfilePics - Whether to include profile pictures (default: true)
     * @param {number} limit - Maximum number of contacts to return (default: 50)
     * @param {number} offset - Number of contacts to skip (default: 0)
     * @returns {Promise<Object>} Contacts result
     */
    async getContacts(instanceId, includeProfilePics = true, limit = 50, offset = 0) {
        try {
            const chatsResult = await this.getChats(instanceId, includeProfilePics, limit, offset);

            return {
                success: true,
                contacts: chatsResult.contacts,
                count: chatsResult.contactsCount,
                profilePicsIncluded: includeProfilePics,
                pagination: chatsResult.pagination
            };
        } catch (error) {
            logger.error(`Error getting contacts from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get groups only with profile pictures
     * @param {string} instanceId - Instance identifier
     * @param {boolean} includeProfilePics - Whether to include profile pictures (default: true)
     * @param {number} limit - Maximum number of groups to return (default: 50)
     * @param {number} offset - Number of groups to skip (default: 0)
     * @returns {Promise<Object>} Groups result
     */
    async getGroups(instanceId, includeProfilePics = true, limit = 50, offset = 0) {
        try {
            const chatsResult = await this.getChats(instanceId, includeProfilePics, limit, offset);

            return {
                success: true,
                groups: chatsResult.groups,
                count: chatsResult.groupsCount,
                profilePicsIncluded: includeProfilePics,
                pagination: chatsResult.pagination
            };
        } catch (error) {
            logger.error(`Error getting groups from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get profile picture with caching and timeout
     * @param {string} instanceId - Instance identifier
     * @param {string} contactId - Contact ID
     * @param {number} timeout - Timeout in milliseconds (default: 3000)
     * @returns {Promise<string|null>} Profile picture URL
     */
    async getProfilePicWithCache(instanceId, contactId, timeout = 3000) {
        const cacheKey = `${instanceId}:${contactId}`;
        const cached = this.profilePicCache.get(cacheKey);

        // Check if cache is valid
        if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
            return cached.url;
        }

        try {
            const instance = this.instances.get(instanceId);
            if (!instance || instance.status !== 'ready') {
                return null;
            }

            // Create timeout promise
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Profile picture timeout')), timeout);
            });

            // Create profile picture promise
            const profilePicPromise = (async () => {
                const contact = await instance.client.getContactById(contactId);
                return await contact.getProfilePicUrl();
            })();

            // Race between timeout and profile picture
            const profilePicUrl = await Promise.race([profilePicPromise, timeoutPromise]);

            // Cache the result
            this.profilePicCache.set(cacheKey, {
                url: profilePicUrl,
                timestamp: Date.now()
            });

            return profilePicUrl;
        } catch (error) {
            // Cache null result to avoid repeated failures
            this.profilePicCache.set(cacheKey, {
                url: null,
                timestamp: Date.now()
            });

            if (error.message === 'Profile picture timeout') {
                logger.warn(`Profile picture timeout for ${contactId} in instance ${instanceId}`);
            }

            return null;
        }
    }

    /**
     * Get multiple profile pictures in batches with concurrency control
     * @param {string} instanceId - Instance identifier
     * @param {Array} contactIds - Array of contact IDs
     * @param {number} batchSize - Number of concurrent requests (default: 5)
     * @param {number} timeout - Timeout per request in milliseconds (default: 3000)
     * @returns {Promise<Map>} Map of contactId -> profilePicUrl
     */
    async getMultipleProfilePics(instanceId, contactIds, batchSize = 5, timeout = 3000) {
        const profilePicMap = new Map();
        const totalContacts = contactIds.length;

        console.log(`🖼️ Instance ${instanceId} - ${totalContacts} profil resmi alınıyor (${batchSize}'li gruplar halinde)...`);

        // Process in batches to avoid overwhelming the system
        for (let i = 0; i < contactIds.length; i += batchSize) {
            const batch = contactIds.slice(i, i + batchSize);
            const batchNumber = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(contactIds.length / batchSize);

            console.log(`📦 Batch ${batchNumber}/${totalBatches} işleniyor (${batch.length} profil resmi)...`);

            const batchPromises = batch.map(async (contactId) => {
                try {
                    const profilePicUrl = await this.getProfilePicWithCache(instanceId, contactId, timeout);
                    return { contactId, profilePicUrl, success: true };
                } catch (error) {
                    logger.warn(`Failed to get profile pic for ${contactId}:`, error.message);
                    return { contactId, profilePicUrl: null, success: false };
                }
            });

            try {
                // Execute batch with overall timeout
                const batchTimeout = timeout * 2; // Give extra time for batch
                const batchResults = await Promise.race([
                    Promise.allSettled(batchPromises),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Batch timeout')), batchTimeout)
                    )
                ]);

                // Process batch results
                batchResults.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        const { contactId, profilePicUrl } = result.value;
                        profilePicMap.set(contactId, profilePicUrl);
                    } else {
                        // If failed, set null
                        profilePicMap.set(batch[index], null);
                    }
                });

                const successCount = batchResults.filter(r => r.status === 'fulfilled' && r.value.success).length;
                console.log(`✅ Batch ${batchNumber} tamamlandı: ${successCount}/${batch.length} başarılı`);

                // Small delay between batches to avoid rate limiting
                if (i + batchSize < contactIds.length) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }

            } catch (error) {
                logger.warn(`Batch ${batchNumber} failed:`, error.message);
                // Set all contacts in failed batch to null
                batch.forEach(contactId => {
                    profilePicMap.set(contactId, null);
                });
                console.log(`❌ Batch ${batchNumber} başarısız: ${error.message}`);
            }
        }

        const successCount = Array.from(profilePicMap.values()).filter(url => url !== null).length;
        console.log(`🎉 Profil resmi alma tamamlandı: ${successCount}/${totalContacts} başarılı`);

        return profilePicMap;
    }

    /**
     * Clear profile picture cache
     * @param {string} instanceId - Instance identifier (optional)
     */
    clearProfilePicCache(instanceId = null) {
        if (instanceId) {
            // Clear cache for specific instance
            for (const [key] of this.profilePicCache) {
                if (key.startsWith(`${instanceId}:`)) {
                    this.profilePicCache.delete(key);
                }
            }
        } else {
            // Clear all cache
            this.profilePicCache.clear();
        }
    }

    /**
     * Check if instance session is still valid
     * @param {string} instanceId - Instance identifier
     * @returns {Promise<boolean>} Session validity
     */
    async checkSessionHealth(instanceId) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance || !instance.client) {
                return false;
            }

            // Try to get client state with timeout
            const statePromise = instance.client.getState();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Health check timeout')), 3000)
            );
            
            const state = await Promise.race([statePromise, timeoutPromise]);
            return state === 'CONNECTED';
        } catch (error) {
            logger.warn(`Session health check failed for instance ${instanceId}:`, error.message);
            return false;
        }
    }

    /**
     * Start keep-alive mechanism for an instance
     * @param {string} instanceId - Instance identifier
     */
    startKeepAlive(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) return;

        // Mevcut keep-alive interval'ı temizle
        if (instance.keepAliveInterval) {
            clearInterval(instance.keepAliveInterval);
        }

        // Her 30 saniyede bir ping-pong yaparak bağlantıyı canlı tut
        instance.keepAliveInterval = setInterval(async () => {
            try {
                if (instance.status === 'ready' && instance.client) {
                    // Basit bir state kontrolü yaparak bağlantıyı test et
                    await instance.client.getState();
                    
                    // Son aktivite zamanını güncelle
                    instance.lastActivity = new Date();
                    
                    console.log(`💓 Instance ${instanceId} keep-alive - bağlantı aktif`);
                }
            } catch (error) {
                console.log(`⚠️ Instance ${instanceId} keep-alive başarısız - bağlantı problemi olabilir`);
                logger.warn(`Keep-alive failed for instance ${instanceId}:`, error.message);
                
                // Keep-alive başarısız olursa immediate health check tetikle
                setTimeout(async () => {
                    const isHealthy = await this.checkSessionHealth(instanceId);
                    if (!isHealthy && instance.status === 'ready') {
                        console.log(`🔄 Instance ${instanceId} keep-alive sonrası health check başarısız - reconnection başlatılıyor`);
                        instance.status = 'disconnected';
                        
                        // Hemen reconnection başlat
                        setTimeout(async () => {
                            try {
                                await this.attemptAutoReconnection(instanceId);
                            } catch (reconnectError) {
                                logger.error(`Keep-alive triggered reconnection failed for instance ${instanceId}:`, reconnectError);
                            }
                        }, 1000);
                    }
                }, 500);
            }
        }, 30000); // 30 saniye aralıklarla

        console.log(`💓 Keep-alive başlatıldı: Instance ${instanceId} (30s interval)`);
        logger.info(`Keep-alive started for instance ${instanceId}`);
    }

    /**
     * Stop keep-alive mechanism for an instance
     * @param {string} instanceId - Instance identifier
     */
    stopKeepAlive(instanceId) {
        const instance = this.instances.get(instanceId);
        if (instance && instance.keepAliveInterval) {
            clearInterval(instance.keepAliveInterval);
            instance.keepAliveInterval = null;
            console.log(`💓 Keep-alive durduruldu: Instance ${instanceId}`);
            logger.info(`Keep-alive stopped for instance ${instanceId}`);
        }
    }

    /**
     * Attempt to recover a disconnected instance
     * @param {string} instanceId - Instance identifier
     * @returns {Promise<boolean>} Recovery success
     */
    async attemptSessionRecovery(instanceId) {
        try {
            console.log(`🔄 Instance ${instanceId} session recovery başlatılıyor...`);

            const instance = this.instances.get(instanceId);
            if (!instance) {
                return false;
            }

            // Mark as recovering
            instance.status = 'recovering';

            // Try to restart the client
            try {
                await instance.client.destroy();
            } catch (error) {
                // Ignore destroy errors
            }

            // Wait a bit before recreating
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Recreate the instance
            await this.recoverInstance(instanceId);

            console.log(`✅ Instance ${instanceId} session recovery tamamlandı`);
            return true;
        } catch (error) {
            console.log(`❌ Instance ${instanceId} session recovery başarısız: ${error.message}`);
            logger.error(`Session recovery failed for instance ${instanceId}:`, error);
            return false;
        }
    }

    /**
     * Execute operation with session recovery
     * @param {string} instanceId - Instance identifier
     * @param {Function} operation - Operation to execute
     * @param {string} operationName - Operation name for logging
     * @returns {Promise<any>} Operation result
     */
    async executeWithRecovery(instanceId, operation, operationName) {
        try {
            // First attempt
            return await operation();
        } catch (error) {
            // Check if it's a session error
            const isSessionError = error.message.includes('Session closed') ||
                                 error.message.includes('Protocol error') ||
                                 error.message.includes('Target closed');

            if (isSessionError) {
                console.log(`⚠️ Instance ${instanceId} session hatası tespit edildi (${operationName})`);
                logger.warn(`Session error detected for instance ${instanceId} during ${operationName}:`, error.message);

                // Attempt recovery
                const recovered = await this.attemptSessionRecovery(instanceId);

                if (recovered) {
                    console.log(`🔄 Instance ${instanceId} recovery sonrası ${operationName} tekrar deneniyor...`);
                    // Wait for instance to be ready
                    await new Promise(resolve => setTimeout(resolve, 3000));

                    // Retry operation
                    return await operation();
                } else {
                    throw new Error(`Session recovery failed for instance ${instanceId}. Please reinitialize the instance.`);
                }
            } else {
                // Re-throw non-session errors
                throw error;
            }
        }
    }

    /**
     * Get messages from a specific chat
     * @param {string} instanceId - Instance identifier
     * @param {string} chatId - Chat ID
     * @param {number} limit - Number of messages to retrieve (default: 50)
     * @returns {Promise<Object>} Messages result
     */
    async getChatMessages(instanceId, chatId, limit = 50) {
        const operation = async () => {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const chat = await instance.client.getChatById(chatId);
            const messages = await chat.fetchMessages({ limit });

            const formattedMessages = messages.map(message => ({
                id: message.id._serialized,
                body: message.body,
                type: message.type,
                timestamp: message.timestamp,
                fromMe: message.fromMe,
                author: message.author,
                to: message.to,
                from: message.from,
                hasMedia: message.hasMedia,
                mediaKey: message.mediaKey,
                isForwarded: message.isForwarded,
                isStatus: message.isStatus,
                isStarred: message.isStarred,
                broadcast: message.broadcast,
                mentionedIds: message.mentionedIds,
                hasQuotedMsg: message.hasQuotedMsg,
                location: message.location,
                vCards: message.vCards,
                inviteV4: message.inviteV4,
                deviceType: message.deviceType
            }));

            instance.lastActivity = new Date();

            console.log(`💬 Instance ${instanceId} - ${formattedMessages.length} mesaj alındı (Chat: ${chatId})`);
            logger.info(`Messages retrieved for instance ${instanceId}, chat ${chatId}: ${formattedMessages.length} messages`);

            return {
                success: true,
                chatId,
                messages: formattedMessages,
                count: formattedMessages.length,
                chatInfo: {
                    id: chat.id._serialized,
                    name: chat.name,
                    isGroup: chat.isGroup,
                    participants: chat.participants ? chat.participants.length : 0
                }
            };
        };

        try {
            return await this.executeWithRecovery(instanceId, operation, 'getChatMessages');
        } catch (error) {
            logger.error(`Error getting messages from instance ${instanceId}, chat ${chatId}:`, error);
            throw error;
        }
    }

    /**
     * Get contact profile information
     * @param {string} instanceId - Instance identifier
     * @param {string} contactId - Contact ID (phone number with @c.us)
     * @returns {Promise<Object>} Contact profile result
     */
    async getContactProfile(instanceId, contactId) {
        const operation = async () => {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            // Ensure contactId has proper format
            const formattedContactId = contactId.includes('@') ? contactId : `${contactId}@c.us`;

            const contact = await instance.client.getContactById(formattedContactId);

            let profilePicUrl = null;
            try {
                profilePicUrl = await contact.getProfilePicUrl();
            } catch (error) {
                // Profile picture might not be available
                logger.warn(`Could not get profile picture for ${formattedContactId}: ${error.message}`);
            }

            const contactInfo = {
                id: contact.id._serialized,
                name: contact.name,
                pushname: contact.pushname,
                shortName: contact.shortName,
                number: contact.number,
                isMe: contact.isMe,
                isUser: contact.isUser,
                isGroup: contact.isGroup,
                isWAContact: contact.isWAContact,
                isMyContact: contact.isMyContact,
                isBlocked: contact.isBlocked,
                profilePicUrl: profilePicUrl,
                statusMute: contact.statusMute,
                isBusiness: contact.isBusiness,
                labels: contact.labels || []
            };

            instance.lastActivity = new Date();

            console.log(`👤 Instance ${instanceId} - ${contact.name || contact.pushname || 'İsimsiz'} profil bilgisi alındı`);
            logger.info(`Contact profile retrieved for instance ${instanceId}, contact ${formattedContactId}`);

            return {
                success: true,
                contactId: formattedContactId,
                profile: contactInfo
            };
        };

        try {
            return await this.executeWithRecovery(instanceId, operation, 'getContactProfile');
        } catch (error) {
            logger.error(`Error getting contact profile from instance ${instanceId}, contact ${contactId}:`, error);
            throw error;
        }
    }

    /**
     * Get multiple contacts profile information
     * @param {string} instanceId - Instance identifier
     * @param {Array} contactIds - Array of contact IDs
     * @returns {Promise<Object>} Multiple contacts profile result
     */
    async getMultipleContactProfiles(instanceId, contactIds) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const profiles = [];
            const errors = [];

            for (const contactId of contactIds) {
                try {
                    const profileResult = await this.getContactProfile(instanceId, contactId);
                    profiles.push(profileResult.profile);
                } catch (error) {
                    errors.push({
                        contactId,
                        error: error.message
                    });
                }
            }

            console.log(`👥 Instance ${instanceId} - ${profiles.length} profil başarıyla alındı, ${errors.length} hata`);
            logger.info(`Multiple contact profiles retrieved for instance ${instanceId}: ${profiles.length} success, ${errors.length} errors`);

            return {
                success: true,
                profiles,
                errors,
                totalRequested: contactIds.length,
                successCount: profiles.length,
                errorCount: errors.length
            };
        } catch (error) {
            logger.error(`Error getting multiple contact profiles from instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Get group information and participants
     * @param {string} instanceId - Instance identifier
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} Group information result
     */
    async getGroupInfo(instanceId, groupId) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const chat = await instance.client.getChatById(groupId);

            if (!chat.isGroup) {
                throw new Error('Provided ID is not a group');
            }

            let groupPicUrl = null;
            try {
                groupPicUrl = await chat.getProfilePicUrl();
            } catch (error) {
                logger.warn(`Could not get group picture for ${groupId}: ${error.message}`);
            }

            const participants = [];
            for (const participant of chat.participants) {
                try {
                    const contact = await instance.client.getContactById(participant.id._serialized);
                    participants.push({
                        id: participant.id._serialized,
                        name: contact.name || contact.pushname,
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    });
                } catch (error) {
                    participants.push({
                        id: participant.id._serialized,
                        name: 'Unknown',
                        isAdmin: participant.isAdmin,
                        isSuperAdmin: participant.isSuperAdmin
                    });
                }
            }

            const groupInfo = {
                id: chat.id._serialized,
                name: chat.name,
                description: chat.description,
                participantCount: chat.participants.length,
                participants: participants,
                owner: chat.owner ? chat.owner._serialized : null,
                createdAt: chat.createdAt,
                groupPicUrl: groupPicUrl,
                isReadOnly: chat.isReadOnly,
                isMuted: chat.isMuted,
                muteExpiration: chat.muteExpiration
            };

            instance.lastActivity = new Date();

            console.log(`🏢 Instance ${instanceId} - ${chat.name} grup bilgisi alındı (${participants.length} üye)`);
            logger.info(`Group info retrieved for instance ${instanceId}, group ${groupId}`);

            return {
                success: true,
                groupId,
                groupInfo
            };
        } catch (error) {
            logger.error(`Error getting group info from instance ${instanceId}, group ${groupId}:`, error);
            throw error;
        }
    }

    /**
     * Get contact's about/status message
     * @param {string} instanceId - Instance identifier
     * @param {string} contactId - Contact ID
     * @returns {Promise<Object>} Contact about result
     */
    async getContactAbout(instanceId, contactId) {
        try {
            const instance = this.instances.get(instanceId);
            if (!instance) {
                throw new Error(`Instance ${instanceId} not found`);
            }

            if (instance.status !== 'ready') {
                throw new Error(`Instance ${instanceId} is not ready. Current status: ${instance.status}`);
            }

            const formattedContactId = contactId.includes('@') ? contactId : `${contactId}@c.us`;
            const contact = await instance.client.getContactById(formattedContactId);

            let about = null;
            try {
                about = await contact.getAbout();
            } catch (error) {
                logger.warn(`Could not get about for ${formattedContactId}: ${error.message}`);
            }

            instance.lastActivity = new Date();

            console.log(`📝 Instance ${instanceId} - ${contact.name || 'İsimsiz'} durum mesajı alındı`);
            logger.info(`Contact about retrieved for instance ${instanceId}, contact ${formattedContactId}`);

            return {
                success: true,
                contactId: formattedContactId,
                name: contact.name || contact.pushname,
                about: about
            };
        } catch (error) {
            logger.error(`Error getting contact about from instance ${instanceId}, contact ${contactId}:`, error);
            throw error;
        }
    }

    /**
     * Start health monitoring for all instances
     */
    startHealthMonitoring() {
        // Check every 10 seconds - çok daha hızlı tespit
        this.healthCheckInterval = setInterval(async () => {
            for (const [instanceId, instance] of this.instances) {
                if (instance.status === 'ready') {
                    try {
                        const isHealthy = await this.checkSessionHealth(instanceId);
                        if (!isHealthy) {
                            console.log(`⚠️ Instance ${instanceId} session sağlık kontrolü başarısız - hemen yeniden bağlanıyor`);
                            logger.warn(`Health check failed for instance ${instanceId} - attempting immediate reconnection`);

                            // Mark as disconnected
                            instance.status = 'disconnected';

                            // Hemen reconnection başlat (60 saniye bekleme)
                            setTimeout(async () => {
                                try {
                                    await this.attemptAutoReconnection(instanceId);
                                } catch (error) {
                                    logger.error(`Immediate reconnection failed for instance ${instanceId}:`, error);
                                }
                            }, 1000); // 1 saniye sonra başlat

                            // Emit status change
                            this.io.emit('instance_status_changed', {
                                instanceId,
                                status: 'disconnected',
                                timestamp: new Date()
                            });
                        } else {
                            // Healthy ise lastActivity güncelle
                            instance.lastActivity = new Date();
                        }
                    } catch (error) {
                        logger.error(`Health monitoring error for instance ${instanceId}:`, error);
                    }
                }
            }
        }, 10000); // 10 saniye - 3x daha hızlı

        console.log('🔍 Session health monitoring başlatıldı (10 saniye aralıklarla - hızlandırıldı)');
        logger.info('Session health monitoring started with 10s interval');
    }

    /**
     * Stop health monitoring
     */
    stopHealthMonitoring() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
            console.log('🔍 Session health monitoring durduruldu');
            logger.info('Session health monitoring stopped');
        }
    }

    /**
     * Start auto-reconnection monitoring
     */
    startAutoReconnection() {
        // Check every 15 seconds for disconnected instances - 4x daha hızlı
        this.reconnectionInterval = setInterval(async () => {
            for (const [instanceId, instance] of this.instances) {
                if (instance.status === 'disconnected' && instance.hasValidAuth && !instance.reconnecting) {
                    console.log(`🔄 Instance ${instanceId} otomatik yeniden bağlanma başlatılıyor (hızlandırılmış)...`);
                    logger.info(`Auto-reconnection started for instance ${instanceId}`);

                    try {
                        await this.attemptAutoReconnection(instanceId);
                    } catch (error) {
                        logger.error(`Auto-reconnection failed for instance ${instanceId}:`, error);
                    }
                }
            }
        }, 15000); // 15 saniye - 4x daha hızlı

        console.log('🔄 Otomatik yeniden bağlanma sistemi başlatıldı (15 saniye aralıklarla - hızlandırıldı)');
        logger.info('Auto-reconnection monitoring started with 15s interval');
    }

    /**
     * Stop auto-reconnection monitoring
     */
    stopAutoReconnection() {
        if (this.reconnectionInterval) {
            clearInterval(this.reconnectionInterval);
            this.reconnectionInterval = null;
            console.log('🔄 Otomatik yeniden bağlanma sistemi durduruldu');
            logger.info('Auto-reconnection monitoring stopped');
        }
    }

    /**
     * Attempt auto-reconnection for a specific instance
     * @param {string} instanceId - Instance identifier
     */
    async attemptAutoReconnection(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return;
        }

        // Prevent multiple reconnection attempts
        if (instance.reconnecting) {
            return;
        }

        instance.reconnecting = true;
        instance.reconnectAttempts = (instance.reconnectAttempts || 0) + 1;

        try {
            console.log(`🔄 Instance ${instanceId} yeniden bağlanma denemesi ${instance.reconnectAttempts}/${this.maxReconnectAttempts}`);

            // If too many attempts, stop trying
            if (instance.reconnectAttempts > this.maxReconnectAttempts) {
                console.log(`❌ Instance ${instanceId} maksimum yeniden bağlanma denemesi aşıldı`);
                instance.status = 'failed';
                instance.reconnecting = false;

                this.io.emit('instance_status_changed', {
                    instanceId,
                    status: 'failed',
                    message: 'Maximum reconnection attempts exceeded',
                    timestamp: new Date()
                });
                return;
            }

            // Try to reinitialize the instance
            console.log(`🔧 Instance ${instanceId} reinitialize çağrılıyor...`);
            await this.reinitializeInstance(instanceId);

            // Reset reconnect attempts on success
            instance.reconnectAttempts = 0;
            instance.reconnecting = false;

            console.log(`✅ Instance ${instanceId} başarıyla yeniden bağlandı!`);
            logger.info(`Auto-reconnection successful for instance ${instanceId}`);

        } catch (error) {
            instance.reconnecting = false;
            console.log(`❌ Instance ${instanceId} yeniden bağlanma başarısız: ${error.message}`);
            logger.error(`Auto-reconnection failed for instance ${instanceId}:`, error);

            // Hata durumunda hemen tekrar denemek yerine biraz bekle
            console.log(`⏳ Instance ${instanceId} ${this.reconnectDelay/1000} saniye sonra tekrar denenecek...`);
            
            setTimeout(() => {
                if (instance.reconnectAttempts < this.maxReconnectAttempts) {
                    console.log(`🔄 Instance ${instanceId} scheduled reconnection başlatılıyor...`);
                    this.attemptAutoReconnection(instanceId);
                } else {
                    console.log(`🛑 Instance ${instanceId} maksimum deneme sayısına ulaşıldı, durduruldu`);
                }
            }, this.reconnectDelay);
        }
    }

    /**
     * Reinitialize an existing instance
     * @param {string} instanceId - Instance identifier
     */
    async reinitializeInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            throw new Error(`Instance ${instanceId} not found`);
        }

        try {
            console.log(`🔄 Instance ${instanceId} reinitialize başlıyor...`);
            
            // Destroy existing client if it exists
            if (instance.client) {
                try {
                    console.log(`🗑️ Instance ${instanceId} eski client destroy ediliyor...`);
                    await instance.client.destroy();
                    console.log(`✅ Instance ${instanceId} eski client destroy edildi`);
                } catch (error) {
                    console.log(`⚠️ Instance ${instanceId} destroy hatası (görmezden gelindi): ${error.message}`);
                }
            }

            // Minimal wait for cleanup - çok daha hızlı
            await new Promise(resolve => setTimeout(resolve, 500));

            console.log(`🚀 Instance ${instanceId} yeni client oluşturuluyor...`);
            
            // Create new client
            const client = new Client({
                authStrategy: new LocalAuth({
                    clientId: instanceId,
                    dataPath: path.join(this.sessionsPath, instanceId)
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--single-process',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-background-networking',
                        '--disable-background-timer-throttling',
                        '--disable-renderer-backgrounding',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-ipc-flooding-protection',
                        '--run-all-compositor-stages-before-draw',
                        '--disable-extensions',
                        '--aggressive-cache-discard'
                    ]
                }
            });

            // Update instance
            instance.client = client;
            instance.status = 'initializing';
            instance.qr = null;

            console.log(`🎧 Instance ${instanceId} event listener'ları kuruluyor...`);
            // Setup event listeners
            this.setupClientEvents(instanceId, client);

            console.log(`⏳ Instance ${instanceId} initialize başlıyor (timeout ile)...`);
            
            // Initialize client with timeout protection
            const initializePromise = client.initialize();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Initialize timeout after 120 seconds')), 120000)
            );
            
            await Promise.race([initializePromise, timeoutPromise]);
            
            console.log(`✅ Instance ${instanceId} initialize başarılı!`);
            return instance;
            
        } catch (error) {
            console.log(`❌ Instance ${instanceId} reinitialize hatası: ${error.message}`);
            instance.status = 'disconnected';
            instance.reconnecting = false; // Hata durumunda flag'i temizle
            logger.error(`Reinitialize failed for instance ${instanceId}:`, error);
            throw error;
        }
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        this.stopHealthMonitoring();
        this.stopAutoReconnection();

        // Destroy all instances
        for (const [instanceId, instance] of this.instances) {
            try {
                // Keep-alive'ı durdur
                this.stopKeepAlive(instanceId);
                
                if (instance.client) {
                    await instance.client.destroy();
                }
                console.log(`🧹 Instance ${instanceId} temizlendi`);
            } catch (error) {
                logger.warn(`Error cleaning up instance ${instanceId}:`, error.message);
            }
        }

        this.instances.clear();
        this.profilePicCache.clear();
        console.log('🧹 WhatsAppManager cleanup tamamlandı');
        logger.info('WhatsAppManager cleanup completed');
    }
}

module.exports = WhatsAppManager;
