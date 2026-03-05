/**
 * notificationWatcher.js
 * ──────────────────────
 * Runs inside the Render Express server (free plan).
 * Uses Firebase Admin SDK onSnapshot listeners to watch Firestore in real-time
 * and sends push notifications to students via the Expo Push API whenever:
 *   • A leave / OD / outing request is approved or rejected
 *   • A new announcement is posted
 *   • A student's marks are updated
 *
 * Call startNotificationWatchers(adminInstance) once after Firebase is initialised.
 */

'use strict';

// ─── Expo Push API helper ────────────────────────────────────────────────────

/** Send a push notification via the Expo Push API */
async function sendExpoPush(token, title, body, data = {}) {
    if (!token || !String(token).startsWith('ExponentPushToken')) {
        return; // invalid / missing token — silently skip
    }

    const payload = {
        to: token,
        sound: 'default',
        title,
        body,
        data,
        badge: 1,
        priority: 'high',
    };

    try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json?.data?.status === 'error') {
            console.warn(`[Push] Expo error for token ${token.slice(-8)}: ${json.data.message}`);
        } else {
            console.log(`[Push] Sent "${title}" → ...${token.slice(-8)}`);
        }
    } catch (err) {
        console.error('[Push] fetch error:', err.message);
    }
}

// ─── Utility helpers ─────────────────────────────────────────────────────────

/** Look up a student's Expo push token from Firestore */
async function getStudentToken(db, studentId) {
    try {
        const snap = await db.collection('students').doc(studentId).get();
        return snap.exists ? (snap.data()?.expo_push_token || null) : null;
    } catch {
        return null;
    }
}

/** Capitalise first letter */
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Format "2026-03-05" or "03-05-2026" → "05 Mar 2026" */
function fmtDate(d) {
    if (!d) return '';
    try {
        const parts = d.split('-');
        if (parts.length !== 3) return d;
        const [a, b, c] = parts;
        const dt = a.length === 4
            ? new Date(Number(a), Number(b) - 1, Number(c))
            : new Date(Number(c), Number(a) - 1, Number(b));
        return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return d;
    }
}

function dateRange(from, to) {
    const f = fmtDate(from);
    const t = fmtDate(to || from);
    return f === t ? f : `${f} – ${t}`;
}

// ─── Watcher factory ─────────────────────────────────────────────────────────

/**
 * Generic watcher for any collection that has a `status` field and a
 * `student_id` field.  Sends a push notification when `status` transitions
 * to one of the `notifyOn` values.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} collection   Collection name
 * @param {string[]} notifyOn   Status values that trigger a notification
 * @param {function} buildMessage   (docData, newStatus, docId) => { title, body, screen }
 */
function watchCollection(db, collection, notifyOn, buildMessage) {
    // Seed map with current document statuses so we don't fire on startup
    const lastStatus = new Map();
    let seeded = false;

    const unsubscribe = db.collection(collection).onSnapshot(
        (snapshot) => {
            if (!seeded) {
                // First snapshot: just record current statuses
                snapshot.docs.forEach((doc) => lastStatus.set(doc.id, doc.data()?.status));
                seeded = true;
                console.log(`[Push] Watching "${collection}" (${snapshot.size} docs seeded)`);
                return;
            }

            snapshot.docChanges().forEach(async (change) => {
                if (change.type !== 'modified' && change.type !== 'added') return;

                const data  = change.doc.data();
                const docId = change.doc.id;
                const prev  = lastStatus.get(docId);
                const curr  = data?.status;

                lastStatus.set(docId, curr);

                // Only act on meaningful forward transitions
                if (!curr || curr === prev || !notifyOn.includes(curr)) return;

                const studentId = data?.student_id;
                if (!studentId) return;

                const token = await getStudentToken(db, studentId);
                if (!token) return;

                const { title, body, screen } = buildMessage(data, curr, docId);
                await sendExpoPush(token, title, body, { screen, requestId: docId });
            });
        },
        (err) => console.error(`[Push] onSnapshot error (${collection}):`, err.message),
    );

    return unsubscribe;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start all Firestore watchers.  Call this once after Firebase Admin is ready.
 * Returns a cleanup function that unsubscribes all listeners (useful for tests).
 *
 * @param {import('firebase-admin')} adminSdk   The already-initialised firebase-admin instance
 */
function startNotificationWatchers(adminSdk) {
    const db = adminSdk.firestore();
    const unsubs = [];

    // ── 1. Leave Applications ─────────────────────────────────────────────
    unsubs.push(watchCollection(
        db,
        'leave_approval',
        ['approved', 'rejected'],
        (data, status) => {
            const emoji = status === 'approved' ? '✅' : '❌';
            const range = dateRange(data.from_date || data.date, data.to_date);
            return {
                title: `${emoji} Leave ${cap(status)}`,
                body:  `Your leave application (${range}) has been ${status}.`,
                screen: 'leave-history',
            };
        },
    ));

    // ── 2. On-Duty (OD) Applications ──────────────────────────────────────
    unsubs.push(watchCollection(
        db,
        'od_requests',
        ['approved', 'rejected', 'completed'],
        (data, status) => {
            const emoji = { approved: '✅', rejected: '❌', completed: '🏆' }[status] || '📋';
            const range = dateRange(data.from_date || data.date, data.to_date);
            const reason = data.purpose || data.reason || 'On-Duty';
            return {
                title: `${emoji} OD Application ${cap(status)}`,
                body:  `Your OD request (${reason}, ${range}) has been ${status}.`,
                screen: 'onduty-history',
            };
        },
    ));

    // ── 3. Outing Requests ────────────────────────────────────────────────
    unsubs.push(watchCollection(
        db,
        'outing_requests',
        ['approved', 'rejected'],
        (data, status) => {
            const emoji = status === 'approved' ? '✅' : '❌';
            const d = fmtDate(data.date || data.from_date);
            const purpose = data.purpose || data.reason || 'Outing';
            return {
                title: `${emoji} Outing ${cap(status)}`,
                body:  `Your outing request (${purpose}, ${d}) has been ${status}.`,
                screen: 'outing-history',
            };
        },
    ));

    // ── 4. Announcements (new doc only) ───────────────────────────────────
    {
        const lastSeen = new Set();
        let seeded = false;

        const unsub = db.collection('announcements').onSnapshot(
            (snapshot) => {
                if (!seeded) {
                    snapshot.docs.forEach((doc) => lastSeen.add(doc.id));
                    seeded = true;
                    console.log(`[Push] Watching "announcements" (${snapshot.size} docs seeded)`);
                    return;
                }

                snapshot.docChanges().forEach(async (change) => {
                    if (change.type !== 'added') return;
                    if (lastSeen.has(change.doc.id)) return;
                    lastSeen.add(change.doc.id);

                    const data = change.doc.data();
                    const title      = data.title    || 'New Announcement';
                    const message    = data.message  || '';
                    const priority   = data.priority || 'normal';
                    const targetRoles = data.target_roles || [];
                    const targetDept  = data.target_department_id || null;

                    const emoji = { normal: '📢', high: '🔔', urgent: '🚨' }[priority] || '📢';
                    const shortBody = message.length > 120 ? message.slice(0, 117) + '...' : message;

                    // Fan out to all students with a token
                    const studentsSnap = await db.collection('students')
                        .where('expo_push_token', '!=', null)
                        .get();

                    const sends = [];
                    studentsSnap.forEach((doc) => {
                        const s     = doc.data();
                        const token = s.expo_push_token;
                        if (!token) return;
                        if (targetDept && s.department_id !== targetDept) return;
                        const role = (s.role || 'STUDENT').toUpperCase();
                        if (targetRoles.length > 0 && !targetRoles.includes(role)) return;
                        sends.push(sendExpoPush(token, `${emoji} ${title}`, shortBody, {
                            screen: 'announcements',
                            announcementId: change.doc.id,
                        }));
                    });

                    await Promise.allSettled(sends);
                    console.log(`[Push] Announcement "${title}" sent to ${sends.length} device(s)`);
                });
            },
            (err) => console.error('[Push] onSnapshot error (announcements):', err.message),
        );

        unsubs.push(unsub);
    }

    // ── 5. Marks updates ──────────────────────────────────────────────────
    {
        const lastMarks = new Map();
        let seeded = false;

        const unsub = db.collection('students').onSnapshot(
            (snapshot) => {
                if (!seeded) {
                    snapshot.docs.forEach((doc) => {
                        lastMarks.set(doc.id, JSON.stringify(doc.data()?.marks || {}));
                    });
                    seeded = true;
                    console.log(`[Push] Watching "students" marks (${snapshot.size} docs seeded)`);
                    return;
                }

                snapshot.docChanges().forEach(async (change) => {
                    if (change.type !== 'modified') return;

                    const data  = change.doc.data();
                    const docId = change.doc.id;
                    const prev  = lastMarks.get(docId) || '{}';
                    const curr  = JSON.stringify(data?.marks || {});

                    lastMarks.set(docId, curr);
                    if (prev === curr) return; // marks didn't actually change

                    const token = data?.expo_push_token;
                    if (!token) return;

                    // Find first changed test name for a descriptive message
                    let changedTest = '';
                    try {
                        const prevMarks = JSON.parse(prev);
                        const newMarks  = data.marks || {};
                        outer: for (const subId of Object.keys(newMarks)) {
                            for (const testName of Object.keys(newMarks[subId] || {})) {
                                if (prevMarks[subId]?.[testName] !== newMarks[subId][testName]) {
                                    changedTest = testName;
                                    break outer;
                                }
                            }
                        }
                    } catch { /* ignore */ }

                    const body = changedTest
                        ? `New marks uploaded for "${changedTest}". Check your Marks page.`
                        : 'Your marks have been updated. Check your Marks page.';

                    await sendExpoPush(token, '📊 Marks Updated', body, {
                        screen: 'marks',
                        studentId: docId,
                    });
                });
            },
            (err) => console.error('[Push] onSnapshot error (students/marks):', err.message),
        );

        unsubs.push(unsub);
    }

    console.log('✅ [Push] All notification watchers started');

    // Return cleanup function
    return () => unsubs.forEach((u) => u && u());
}

module.exports = { startNotificationWatchers };
