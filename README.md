# CheckinPlus Backend API

This backend server provides Admin SDK functionality for operations that cannot be performed from the client-side, such as password resets.

## Setup Instructions

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **Project Settings** (gear icon) → **Service Accounts**
4. Click **Generate New Private Key**
5. Save the downloaded JSON file as `serviceAccountKey.json` in the root directory of the project (parent of backend folder)
   ```
   CheckinPlus/
   ├── serviceAccountKey.json  ← Place it here
   ├── backend/
   ├── web-dashboard/
   └── mobile-app/
   ```

### 3. Start the Backend Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

The server will start on **http://localhost:3001**

## API Endpoints

### POST /api/admin/reset-password
Reset a user's password to 'welcome@123'

**Request Body:**
```json
{
  "uid": "firebase-user-uid",
  "email": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Password reset to welcome@123 successfully"
}
```

## Important Notes

- ⚠️ The `serviceAccountKey.json` file contains sensitive credentials
- ⚠️ **NEVER** commit this file to version control
- ⚠️ Add it to `.gitignore` immediately
- The server must be running for password reset functionality to work in the web dashboard

## Security

This backend should only be accessible from trusted admin clients. In production:
- Implement proper authentication/authorization
- Use environment variables for configuration
- Deploy securely (e.g., Firebase Cloud Functions, dedicated server with firewall)
- Add rate limiting to prevent abuse
