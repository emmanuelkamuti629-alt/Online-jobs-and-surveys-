services:
  - type: web
    name: jobpay
    env: node
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: NODE_ENV
        value: production
      - key: MONGODB_URI
        sync: false          # you'll fill this in the dashboard
      - key: JWT_SECRET
        sync: false
      - key: PAYHERO_API_KEY
        sync: false
      - key: PAYHERO_USERNAME
        sync: false
      - key: PAYHERO_CALLBACK_URL
        value: https://your-service.onrender.com/api/payhero/callback
