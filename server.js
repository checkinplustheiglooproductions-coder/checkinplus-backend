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

// Update Email Endpoint (keeps same UID, updates Firebase Auth email only)
app.post('/api/admin/update-email', async (req, res) => {
    try {
        const { uid, newEmail } = req.body;

        if (!uid || !newEmail) {
            return res.status(400).json({
                success: false,
                error: 'Both uid and newEmail are required'
            });
        }

        const cleanEmail = newEmail.toLowerCase().trim();
        await admin.auth().updateUser(uid, { email: cleanEmail });

        console.log(`✅ Email updated for UID ${uid} → ${cleanEmail}`);

        res.json({
            success: true,
            message: `Auth email updated to ${cleanEmail}. UID preserved.`
        });

    } catch (error) {
        console.error('❌ Update email error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Delete all Firebase Auth accounts where email starts with a given prefix
// Body: { "prefix": "22ad" }
app.post('/api/admin/purge-auth-by-email-prefix', async (req, res) => {
    try {
        const { prefix } = req.body;
        if (!prefix) return res.status(400).json({ success: false, error: 'prefix is required' });

        const lowerPrefix = prefix.toLowerCase().trim();
        const uidsToDelete = [];
        let pageToken = undefined;

        // Page through ALL auth users and collect matching UIDs
        do {
            const listResult = await admin.auth().listUsers(1000, pageToken);
            listResult.users.forEach(u => {
                if (u.email && u.email.toLowerCase().startsWith(lowerPrefix)) {
                    uidsToDelete.push(u.uid);
                }
            });
            pageToken = listResult.pageToken;
        } while (pageToken);

        if (uidsToDelete.length === 0) {
            return res.json({ success: true, message: `No accounts found with email starting with "${prefix}"`, deleted: 0, failed: 0 });
        }

        console.log(`🗑️  Deleting ${uidsToDelete.length} Auth account(s) with email prefix "${prefix}"...`);

        let totalDeleted = 0;
        let totalFailed = 0;
        const errors = [];

        for (let i = 0; i < uidsToDelete.length; i += 1000) {
            const batch = uidsToDelete.slice(i, i + 1000);
            const result = await admin.auth().deleteUsers(batch);
            totalDeleted += result.successCount;
            totalFailed += result.failureCount;
            result.errors.forEach(e => errors.push({ uid: batch[e.index], error: e.error.message }));
        }

        console.log(`✅ Prefix purge complete — deleted: ${totalDeleted}, failed: ${totalFailed}`);

        res.json({
            success: true,
            message: `Deleted ${totalDeleted} account(s) with email starting with "${prefix}"`,
            deleted: totalDeleted,
            failed: totalFailed,
            errors
        });

    } catch (error) {
        console.error('❌ Prefix purge error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Bulk Delete ALL Student Auth Accounts
// Reads every doc in the 'students' Firestore collection, then deletes their
// Firebase Auth accounts in batches of 1000 using deleteUsers().
// Firestore documents are NOT touched — only Auth accounts are removed.
app.post('/api/admin/purge-student-auth', async (req, res) => {
    try {
        const db = admin.firestore();
        const snap = await db.collection('students').get();

        if (snap.empty) {
            return res.json({ success: true, message: 'No students found in Firestore.', deleted: 0, failed: 0 });
        }

        // Collect UIDs — prefer firebase_uid field, fall back to doc ID
        const uids = snap.docs
            .map(d => d.data().firebase_uid || d.id)
            .filter(Boolean);

        console.log(`🗑️  Purging Firebase Auth for ${uids.length} student(s)...`);

        let totalDeleted = 0;
        let totalFailed = 0;
        const errors = [];

        // deleteUsers() handles max 1000 UIDs per call
        for (let i = 0; i < uids.length; i += 1000) {
            const batch = uids.slice(i, i + 1000);
            const result = await admin.auth().deleteUsers(batch);
            totalDeleted += result.successCount;
            totalFailed += result.failureCount;
            result.errors.forEach(e => errors.push({ uid: batch[e.index], error: e.error.message }));
        }

        console.log(`✅ Student Auth purge complete — deleted: ${totalDeleted}, failed: ${totalFailed}`);

        res.json({
            success: true,
            message: `Auth purge complete. Deleted: ${totalDeleted}, Failed: ${totalFailed}`,
            deleted: totalDeleted,
            failed: totalFailed,
            errors
        });

    } catch (error) {
        console.error('❌ Purge student auth error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Purge all request collections ─────────────────────────────────────────
app.post('/api/admin/purge-all-requests', async (req, res) => {
    try {
        const db = admin.firestore();
        const collections = [
            'leave_requests', 'onduty_requests', 'outing_requests',
            'leave_approval', 'od_requests'  // legacy collection names
        ];

        let totalDeleted = 0;

        for (const colName of collections) {
            const snapshot = await db.collection(colName).get();
            if (snapshot.empty) continue;

            // Delete in batches of 400
            const chunks = [];
            for (let i = 0; i < snapshot.docs.length; i += 400) {
                chunks.push(snapshot.docs.slice(i, i + 400));
            }
            for (const chunk of chunks) {
                const batch = db.batch();
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
                totalDeleted += chunk.length;
            }
            console.log(`🗑️  Purged ${snapshot.docs.length} docs from ${colName}`);
        }

        res.json({ success: true, deleted: totalDeleted });
    } catch (error) {
        console.error('❌ Purge all requests error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
app.listen(port, () => {
    console.log(`🚀 CheckinPlus Backend API running at http://localhost:${port}`);
});
