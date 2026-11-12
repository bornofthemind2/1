# RideBridge

RideBridge takes Lyft Driver ride requests from your Android phone and puts them on your car's screen. It works with **Android Auto**, **Apple CarPlay**, and **Tesla** (through Fleet API navigation plus a dashboard in the in-car browser). It also scores each request and routes your car to the pickup, then to the drop-off.

```
 Lyft Driver app (Android)
   │  notification text / request-card text   (read-only)
   ▼
 RideBridge Android app ───────────────► Android Auto screen
   │  HTTPS POST /api/rides                 (alert + "Navigate" + "Send to Tesla")
   ▼
 RideBridge server (Node, no dependencies)
   ├─ parses and scores the request ($/mi, $/hr, pickup ETA, rider rating → GO / MAYBE / SKIP)
   ├─ Tesla Fleet API: navigation_request / navigation_gps_request
   │     (sends the pickup on accept and the drop-off on trip start)
   ├─ SSE /api/stream ─► Tesla in-car browser dashboard (/)
   └─ SSE /api/stream ─► iOS CarPlay app
```

## What it does and doesn't do

- **Reads only.** It never taps "Accept" or otherwise interacts with the Lyft app. You still accept rides in Lyft. Auto-accepting would break Lyft's Terms of Service and would put a phone interaction into your driving.
- Lyft has **no public driver API**, so the data comes from the Lyft Driver app's notifications and, optionally, the on-screen request card through an Android accessibility service. Lyft can change that text at any time. The parser in `server/src/parser.js` is heuristic, and every field is optional. Reading another app's screen may still conflict with Lyft's terms, so use it at your own discretion.
- **iPhone can't extract the data.** iOS doesn't let apps read other apps' notifications or screens. The CarPlay app shows rides captured by an Android phone, or text you send with an iOS Shortcut (see below).
- **Tesla doesn't run third-party apps** on its screen. RideBridge uses the official Fleet API to set the car's navigation destination, plus a web dashboard you open in the Tesla browser (it works while parked).

## 1. Server

```bash
cd server
cp .env.example .env    # set BRIDGE_TOKEN, plus the Tesla values if you use Tesla
set -a; . ./.env; set +a
npm start               # http://localhost:8787
npm test
```

Deploy it somewhere with HTTPS that your phone can reach on cellular (Render, Fly.io, or a VPS behind Caddy). The Android app only talks to `https://` URLs.

### API (all `/api/*` routes need `Authorization: Bearer <BRIDGE_TOKEN>` or `?key=`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/rides` | `{source, status, title, text, lines[], pickup?:{lat,lon}, dropoff?:{lat,lon}}`. `status` is `request` (default), `accepted`, `in_trip`, `completed`, or `cancelled`. A request creates a ride; other statuses update the latest ride (or `rideId`) and trigger auto-navigation. |
| GET | `/api/rides`, `/api/rides/latest` | Recent rides |
| POST | `/api/rides/:id/navigate` | `{target: "pickup" \| "dropoff"}`: sends that location to the Tesla |
| GET | `/api/stream` | Server-Sent Events: `hello`, `ride`, `update` |
| GET | `/` | Dashboard (Tesla browser, tablet, or phone) |

### Tesla setup
1. Create an app at [developer.tesla.com](https://developer.tesla.com) with the `vehicle_device_data` and `vehicle_cmds` scopes, host your public key, and register with the Fleet API in your region.
2. Complete OAuth for your account and put `TESLA_CLIENT_ID`, `TESLA_REFRESH_TOKEN`, and `TESLA_VIN` in `.env`.
3. Newer vehicles need signed commands. Run [`tesla-http-proxy`](https://github.com/teslamotors/vehicle-command), pair your key with the car, and set `TESLA_API_BASE` to the proxy.
4. In the car, open the browser to `https://your-bridge/?key=<BRIDGE_TOKEN>`. The token is remembered after the first visit.

## 2. Android app (`android/`): reader and Android Auto

Open `android/` in Android Studio (AGP 8.5, compileSdk 35) and run it on your phone.

1. Enter the server URL and token, then tap **Save**.
2. **Allow notification access** for RideBridge.
3. Optional: enable the **request-card reader** accessibility service. It's limited to `com.lyft.android.driver` and reads more detail, such as fare and trip length.
4. Android Auto: for a sideloaded build, turn on Android Auto developer settings (tap the version 10 times), then enable **Unknown sources**. RideBridge appears in the launcher. When a request arrives, it shows an alert with the fare and verdict. The ride screen has **Navigate to pickup** (opens your car navigation app) and **Send to Tesla**.

Main files:
- `LyftNotificationListener.kt`: reads Lyft Driver notifications and classifies them as request, accepted, in trip, or completed.
- `LyftScreenReaderService.kt`: optional reader for the request card's text. It never clicks anything.
- `car/RideScreen.kt`: the Android Auto UI (Car App Library `PaneTemplate` and `Alert`).

## 3. iOS CarPlay (`ios/`)

Add the Swift files to an iOS 16+ app target and merge `Info.plist.snippet.xml` into Info.plist. You also need the **CarPlay Driving Task entitlement**, which you request from Apple. The app subscribes to `/api/stream` and shows the current ride. It has buttons for **Maps to pickup** (Apple Maps on the CarPlay screen) and **Send to Tesla**.

If you only have an iPhone, create an iOS Shortcut ("Share → Get Text → Get Contents of URL", POST JSON `{"text": <input>, "source": "ios-shortcut", "force": true}` to `/api/rides`). Then share a screenshot's text or a copied address into it.

## Driving safety
Everything shown in the car is read-only and glanceable, with large text and one-tap actions. Use the hands-free options (auto-navigate on accept) instead of touching screens while you're moving.
