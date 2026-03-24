---
title: Authentication
description: VLM API authentication methods
---

## Email/Password Auth

### Register

```http
POST /api/auth/register
Content-Type: application/json

{ "email": "user@example.com", "password": "securepass", "displayName": "User" }
```

Returns `{ accessToken, refreshToken, user }`. The first user to register is automatically promoted to admin (in single/scalable mode).

### Login

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "user@example.com", "password": "securepass" }
```

### Refresh Token

```http
POST /api/auth/refresh
Content-Type: application/json

{ "refreshToken": "..." }
```

Returns a new `{ accessToken }`.

## Platform Auth

For in-world clients (Decentraland, Hyperfy), authentication uses platform-specific proofs:

```http
POST /api/auth/platform
Content-Type: application/json

{
  "proof": { "type": "signed-fetch", "payload": { ... } },
  "platformData": {
    "sceneId": "uuid",
    "user": { "id": "0x...", "displayName": "Player" },
    "world": "decentraland",
    "location": { ... }
  }
}
```

Auto-creates a user account from the platform identity if one doesn't exist.

## Using Tokens

Include the access token in the `Authorization` header:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

Access tokens expire after 15 minutes. Use the refresh endpoint to get new ones.
