# Wasl protocol, version 1

The PC listens; the phone connects. Everything after the handshake is encrypted
with AES-256-GCM using keys that only the paired phone and PC know.

## Ports

| Port  | Proto | Purpose |
|-------|-------|---------|
| 47800 | TCP   | The link (PC listens) |
| 47801 | UDP   | Discovery: the phone asks "where is PC `<id>`?" |

## Pairing

The PC shows a QR code (valid 5 minutes) containing:

```
wasl://pair?v=1&id=<pcId>&n=<pcName>&h=<ip1,ip2,...>&p=47800&k=<key>
```

`k` is a fresh random 32-byte key (base64url). Both sides store it. Nothing
secret ever crosses the network after this: the key never leaves the QR code.

## Framing

Each frame is a 4-byte big-endian length followed by the body (max 4 MiB).

- Body `0x00 + JSON` – plaintext, only the two `hello` frames.
- Body `0x01 + ciphertext||tag` – AES-256-GCM.

## Handshake

1. Phone → `{"t":"hello","v":1,"dev":"<deviceId hex>","nonce":"<16 random bytes b64>"}`
2. PC looks up the key for `dev` (or the pending pairing key).
   Unknown device → `{"t":"error","code":"unpaired"}` and close.
   PC → `{"t":"hello","v":1,"pc":"<pcId>","nonce":"<16 random bytes b64>"}`
3. Both derive per-direction session keys:
   - phone→PC: `HMAC-SHA256(K, "wasl/v1/c2s" || nonceC || nonceS)`
   - PC→phone: `HMAC-SHA256(K, "wasl/v1/s2c" || nonceC || nonceS)`
4. GCM nonce = 4 zero bytes || 8-byte big-endian frame counter (starts at 0,
   one counter per direction). A replayed, reordered or forged frame fails
   to decrypt and the connection is closed.
5. Phone → (encrypted) `{"t":"auth","name":..,"model":..}`; PC → `{"t":"welcome","name":..}`.

## Encrypted payload

`u32 jsonLength || JSON || optional binary`.

## Messages

| Type | Direction | Fields |
|------|-----------|--------|
| `ping` / `pong` | both | – |
| `battery` | phone→PC | `level`, `charging` |
| `notif.posted` | phone→PC | `key`, `pkg`, `app`, `title`, `text`, `time`, `icon` (b64 png), `actions[{i,title,reply}]` |
| `notif.removed` | phone→PC | `key` |
| `notif.snapshot` | phone→PC | `items[]` |
| `notif.request` | PC→phone | asks for a `notif.snapshot` |
| `notif.dismiss` | PC→phone | `key` |
| `notif.action` | PC→phone | `key`, `i`, `reply?` |
| `clip` | both | `text` |
| `share.text` | phone→PC | `text` |
| `ring` | PC→phone | `on` |
| `ring.state` | phone→PC | `on` |
| `unpaired` | both | the sender forgot the pairing |
| `file.offer` | both | `id`, `name`, `size` |
| `file.chunk` | both | `id`, binary data |
| `file.end` | both | `id`, `sha256` |
| `file.cancel` | both | `id` |
