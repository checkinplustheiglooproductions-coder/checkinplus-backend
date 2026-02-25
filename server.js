const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ── Initialize Firebase Admin SDK ──────────────────────────────────────────
// Priority 1: Environment variable FIREBASE_SERVICE_ACCOUNT_JSON (used on Render / cloud)
// Priority 2: Local serviceAccountKey.json file (used when running locally)
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log('✅ Firebase Admin SDK initialized from environment variable');
    } else {
        const serviceAccountPath = path.join(__dirname, '..', 'serviceAccountKey.json');
        if (fs.existsSync(serviceAccountPath)) {
            const serviceAccount = require(serviceAccountPath);
            admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
            console.log('✅ Firebase Admin SDK initialized from serviceAccountKey.json');
        } else {
            console.warn('⚠️  No service account found. Set FIREBASE_SERVICE_ACCOUNT_JSON env var or add serviceAccountKey.json');
        }
    }
} catch (error) {
    console.error('❌ Firebase Admin SDK initialization failed:', error.message);
}

// Routes
app.get('/', (req, res) => {
    res.json({ message: 'CheckinPlus Backend API', status: 'running' });
});

// Password Reset Endpoint
app.post('/api/admin/reset-password', async (req, res) => {
    try {
        const { uid, email } = req.body;

        if (!uid && !email) {
            return res.status(400).json({ 
                success: false, 
                error: 'Either uid or email is required' 
            });
        }

        // Update user password to 'welcome@123'
        await admin.auth().updateUser(uid || email, {
            password: 'welcome@123'
        });

        console.log(`✅ Password reset for user: ${uid || email}`);

        res.json({ 
            success: true, 
            message: 'Password reset to welcome@123 successfully' 
        });

    } catch (error) {
        console.error('❌ Password reset error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Delete User Endpoint (HARD DELETE from Firebase Auth)
app.post('/api/admin/delete-user', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ 
                success: false, 
                error: 'User ID (uid) is required' 
            });
        }

        // Delete user from Firebase Auth (permanent deletion)
        await admin.auth().deleteUser(uid);

        console.log(`✅ User deleted from Firebase Auth: ${uid}`);

        res.json({ 
            success: true, 
            message: 'User deleted from Firebase Auth successfully' 
        });

    } catch (error) {
        console.error('❌ Delete user error:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
});

// Start server
app.listen(port, () => {
    console.log(`🚀 CheckinPlus Backend API running at http://localhost:${port}`);
});
