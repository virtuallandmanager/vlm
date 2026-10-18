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

## API Keys

For scripts and servers, create an API key while signed in:

```http
POST /api/keys
Authorization: Bearer <access token>
Content-Type: application/json

{ "name": "my script", "expiresAt": "2027-01-01T00:00:00Z" }
```

The response contains the key (`vlm_k1_…`) once; only its hash is stored. Send it like a token: `Authorization: Bearer vlm_k1_…`.

A key acts with its account's full access: it can do anything the account can, and there are no narrower scopes. A key cannot create other keys: `POST /api/keys` with a key returns `403`. Delete a key with `DELETE /api/keys/:keyId`.
