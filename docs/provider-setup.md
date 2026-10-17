# DisplayOS sources and photos

DisplayOS has two ways to receive family information. An assistant can send a family update through its approved display connection. Optional Google adapters can read sources that the owner selects. Connecting Google does not give an assistant access to Google credentials and does not automatically put private information on a screen.

## What works in code

`cloud/src/product/family.js` validates the version 1 family update described in `docs/product-contract.md`. Timestamps are integer Unix milliseconds. Temperatures are Celsius. It rejects unknown fields, markup, links, invalid dates or time zones, stale generation times and updates lasting more than 24 hours. Optional lists become empty lists. It does not truncate excessive family lists silently.

`cloud/src/product/media.js` accepts canonical base64 JPEG or PNG input no larger than 96 KiB. It checks file structure and dimensions before allocating pixel buffers. Each side is limited to 2048 pixels, and the image must contain at most four million pixels. It then decodes the pixels and writes a new image. EXIF, comments, location tags and other original metadata do not reach stored output. The normalized file must also fit 96 KiB.

The Favorite faces picker accepts JPEG, PNG and WebP originals up to 20 MB. It makes a JPEG copy, repeatedly reducing dimensions when compression alone does not fit the upload limit. Server JPEG sanitizing starts at quality 80 and tries 65, 50, 35 and 20 if its new encoding exceeds the limit. Neither layer raises the byte limit or bypasses strict decoding. Detailed-photo regressions exercise both layers together. Progress and retry guidance remain visible inside Favorite faces, and a failed selection is cleared so the same file can be chosen again.

Supported JPEGs use baseline or progressive eight-bit grayscale or RGB color. JPEG decoding is strict, with a four-megapixel and 64 MiB decoder allocation limit. PNG support is eight-bit, non-interlaced RGB or RGBA. Animated, indexed, interlaced, high-bit-depth and transparency-key PNGs fail closed. The browser photo picker converts supported originals to JPEG before upload. Direct server uploads of SVG, GIF, WebP, arbitrary image URLs, appended file data and damaged files are not accepted.

PNG decoding uses the pinned pngjs filter and bitmap decoder with a bounded public `node:zlib.inflateSync` call. It does not use pngjs's private Node zlib handle or its unbounded interlaced decoder. jpeg-js and pngjs are synchronous decoders. Production CPU limits and actual Cloudflare compatibility must be checked in the parent release tests, particularly for the largest accepted photos. These tests do not certify every possible malformed image.

## Google setup for the operator

This is not a task for the family. Configure the service before exposing the Google connection button.

1. Create a Google Cloud OAuth client for a web application and enable Google Calendar API. Enable Gmail API only if inbox reminders are offered.
2. Register the exact deployed callback, `https://YOUR_HOST/api/v1/providers/google/callback`. The adapter rejects alternate callback addresses.
3. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets. Do not add them to public assets, browser storage, an assistant conversation or a tablet.
4. Configure Google consent-screen branding, approved test users during testing and production verification where Google requires it. Gmail metadata permissions can require Google's restricted-scope verification. Code presence is not approval.
5. Wire adapter calls only through owner-authenticated routes. Mutating browser calls need DisplayOS's origin and CSRF checks. The callback must authenticate the same owner account that started its state-bound transaction.

The authorization request uses PKCE and a five-minute, single-use state bound to the owner. Pending requests are bounded to four per account. Tokens are stored through the encrypted server `RecordStore`; only public connection status returns to the phone. Disconnect deletes the local vault and invalidates pending or in-flight connection work before attempting Google's token revocation. If Google's revocation request fails, the result reports `revokedAtProvider:false`. The user must then remove the connection in their Google account to stop any remaining provider authorization.

### Calendar

Request only `https://www.googleapis.com/auth/calendar.events.readonly`. The owner must select up to three calendar IDs at connection time. `primary` selects their main calendar. The adapter never enumerates every calendar or accepts an unapproved calendar later. It reads event summaries and starts, not descriptions, attachments or attendee lists. Returned content contains seven local dates with at most two events per day.

### Inbox reminders

Inbox is off unless the owner explicitly chooses it. Request only `https://www.googleapis.com/auth/gmail.metadata`, not Gmail modification or full-mail access. The adapter lists at most four inbox message IDs and requests only Subject metadata. It never asks for email bodies, snippets, attachments or send permission. Returned reminder titles use cleaned, bounded subject lines.

Subjects can still be sensitive. Explain that enabling display sharing could show an email subject to other people in the room. Do not describe this as private email summarization or assume every subject belongs on a family screen.

### Sharing is a separate choice

After Google authorization, both calendar and inbox display-sharing choices are false. The owner can preview permitted source results on their phone. `setSharing` is a separate owner action and cannot enable a source that was not authorized. Calendar and inbox results include `sharingAllowed` for the parent integration to enforce before copying them into a family update. The adapter never publishes by itself.

An independently approved assistant can compose information it already has permission to read. That permission belongs to the assistant's provider integration, not this Google vault. DisplayOS's assistant grant alone never authorizes reading the vault or connecting a family account.

## Adapter interface

`createProviderAdapters({env,store,fetch,now,origin})` returns these server-only methods:

- `status(accountId)` returns `{available,configured,connected,calendar,inbox,calendarIds,sharing,geocodingAvailable,weatherAvailable,nearbyAvailable}`. OAuth availability and Maps availability are separate. Missing secrets never produce a configured or connected success.
- `beginGoogle(accountId,{calendar,inbox,calendarIds,redirectUri?})` returns `{url,expiresAt}`. Both source choices are booleans. Selecting calendars requires an explicit nonempty list of up to three IDs. `redirectUri`, when supplied, must match the fixed callback.
- `finishGoogle(accountId,{code,state})` returns the same public connection status. Only code and state enter this method; the route may ignore known Google callback metadata without using it as authority.
- `calendar(accountId,{timezone,calendarIds?})` returns `{week,sharingAllowed,fetchedAt}`. Requested IDs must be a subset of the previously approved IDs.
- `inbox(accountId,{timezone?})` returns `{reminders,sharingAllowed,fetchedAt}`.
- `setSharing(accountId,{calendar,inbox})` persists separate display-sharing choices and returns public status.
- `disconnect(accountId)` returns `{disconnected:true,revokedAtProvider}`.
- `weather({latitude,longitude,timezone,consent})` returns `{weather,fetchedAt,attribution}`.
- `location(homeId)` returns `{version,location,geocodingAvailable,weatherAvailable,nearbyAvailable}`. `location` is null or private owner data `{address,weather,nearby,savedAt}`. Never expose this response through a device or assistant route.
- `saveLocation(homeId,{address,weather,nearby})` saves user input and consent only, with a new monotonic version on every call. An empty address with both choices false clears the input but retains its version tombstone. It makes no provider requests.
- `googleWeather(homeId,timezone)` and `nearby(homeId)` return `{available:true,weather|nearby,cityLabel,attribution:'Google Maps',thirdPartyAttributions:[],locationVersion,fetchedAt,expiresAt,ephemeral:true}`. Weather also returns `weatherSourceAttribution:'Source: Includes weather data from Google'`. Expiry is one hour. These results must not enter durable family updates, exports, logs or offline caches.

All adapter URLs are fixed official HTTPS endpoints. Provider requests refuse redirects, use a ten-second abort deadline and bound decoded response bodies. Provider errors never return token responses or credentials to the phone. Tokens refresh only on the server and never expand the granted source permissions. A disconnected account cannot be resurrected by a delayed OAuth callback or token refresh.

## Home location, weather and nearby places

The owner enters one home address or city for the selected home. Input is limited to 240 characters and rejects markup, controls and URLs. "Save privately" leaves both sharing choices off. "Use for weather and nearby places" deliberately permits city information on that home's screens. The explanation distinguishes the private full address from shared city information. No GPS, IP-location guessing, key entry or separate provider account is required from the family.

The encrypted `provider:location:HOME_ID` record contains only the user's input, consent, version and saved time. Google lookup first resolves the input, then resolves the city center if the input was a street address. Weather and nearby requests use that city center, never the house coordinates. Ambiguous results fail instead of guessing. No derived Google address, city label, coordinates, forecast or place names are stored by the adapter.

Owner routes are POST with browser authentication, CSRF and verified home ownership:

- `/api/v1/providers/location` takes `{homeId}`.
- `/api/v1/providers/location/save` takes `{homeId,address,weather,nearby}`.
- `/api/v1/providers/google/weather` and `/api/v1/providers/google/nearby` take only `{homeId}`. The weather route obtains the time zone from verified home settings.

The Sources panel works before a screen is paired. Saving location does not make an API call. Configured, consenting screens receive live information separately through authenticated `/device/v1/local`. Poll responses expose only enabled source flags and the location version. The parent integration must recheck home assignment, device credential epoch, screen membership and location version after fetching. The adapter also rechecks location version and consent before returning. A change rejects delayed results with 409.

The screen renderer holds live Google content in memory only while online and visible. It refreshes before the one-hour expiry, clears on expiry, offline, night, reset or lost authorization, and discards changed-location responses. Owner previews follow the same transient rule and never call `family.publish`. Nearby results are at most three parks, libraries or museums, not events or claims about opening hours.

### Maps setup for the operator

Use the user-approved existing external Google Cloud project. Project access, billing linkage and API enablement belong to the parent operator task, not these adapters. Billing must be approved separately. The module tests make no real Google API calls and establish no account connection.

Enable `geocoding-backend.googleapis.com`, `weather.googleapis.com` and `places.googleapis.com`. Store API-restricted keys as Worker secrets `GOOGLE_GEOCODING_API_KEY`, `GOOGLE_WEATHER_API_KEY` and `GOOGLE_PLACES_API_KEY`. Use separate keys restricted to their respective APIs. Never expose them through public assets or phone forms. Server IP restrictions require a stable outbound address; ordinary Cloudflare Worker egress is not automatically a fixed IP. Review quota controls and key restrictions before real traffic.

The adapter uses fixed endpoints and bounded responses:

- Geocoding v3 GET `https://maps.googleapis.com/maps/api/geocode/json`, address and optional country filter, maximum response 128 KiB.
- Weather GET `https://weather.googleapis.com/v1/forecast/days:lookup`, seven days, page size seven, metric units and English labels, maximum response 128 KiB.
- Places POST `https://places.googleapis.com/v1/places:searchNearby`, at most three results within 5 km of the city center. Field mask is exactly `places.displayName,places.primaryTypeDisplayName,places.attributions`, maximum response 32 KiB. These fields use a billed Nearby Search tier; a small result count does not make it free.

Every outbound Geocoding, Weather or Places request first reserves one request in the encrypted transactional singleton `provider:google-budget`. The service-wide maximum is 300 requests per UTC day, including owner previews, failures, rejected responses and timeouts. Restarts and concurrent adapters do not reset it. Clock rollback or a corrupt record fails closed. Exhaustion returns 429 before another network call. The parent adds device and owner admission limits. This is a request cap, not a dollar budget or a guarantee that Google's monthly free allowance covers usage. Other applications using the same project do not pass through this cap.

### Google terms and attribution

The current [service-specific terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) permit limited Geocoding coordinate caching and daily forecast caching. They do not provide general permission to retain Places names. This implementation stores no derived Google content and excludes local results from family history and offline caches. An hour-long online display is not an approval to retain that content afterward. Applicable terms can differ for EEA billing addresses. Review the project's agreement before commercial use.

Show Google attribution beside the Google content, not beside unrelated family data. Use official logo assets where space permits. A constrained card may use the exact unwrapped, untranslated text `Google Maps`, with `translate="no"`, normal sans-serif text at 12 to 16 pixels and adequate contrast. Weather additionally requires `Source: Includes weather data from Google`. See the current [Weather attribution policy](https://developers.google.com/maps/documentation/weather/policies).

Places can return third-party names and attribution links. This release rejects results with nonempty third-party attribution rather than hiding it or emitting an unreviewed external URL. Supporting those results needs an approved link and rendering contract. Operator release gates include public privacy and terms pages, required provider acknowledgements, agreement review and live delivery checks. Unit tests are not a commercial legal certification. See [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies).

### Legacy Open-Meteo adapter

Weather uses a location deliberately chosen by the owner. It never requests device GPS permission. `consent` must be true, coordinates must be valid and the time zone must be valid.

For commercial use, configure `OPEN_METEO_API_KEY` and satisfy Open-Meteo's subscription and attribution terms. The adapter then uses the fixed `customer-api.open-meteo.com` endpoint. For a strictly noncommercial demo, the operator may explicitly configure `OPEN_METEO_NONCOMMERCIAL_DEMO=true`, which permits the public endpoint. Without either configuration, weather is unavailable. Do not silently turn on the free endpoint for a commercial product.

The adapter returns at most seven Celsius forecasts. Display the returned Open-Meteo attribution wherever this forecast is shown. It does not accept custom fetch URLs, geocoding URLs or arbitrary hosts.

## Verification and remaining gates

Run from `cloud`:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/product-family.test.js test/product-media.test.js test/product-providers.test.js test/product-provider-ui.test.js
```

Tests use labeled synthetic accounts and local provider fixtures. They check schema bounds, real image decoding, stripped metadata, expansion limits, OAuth and sharing separation, disconnect races, source failures, location isolation and monotonic versions, city-only requests, strict response bounds, delayed consent withdrawal and the persistent global request cap. Browser fixtures check the one-field location flow, unavailable states, separate calendar sharing, preserved family TTL, attribution and no durable Google publication. Browser tests use `PLAYWRIGHT_MODULE` or the existing local Playwright installation; they do not install a new dependency.

No real Google account has been connected by these module tests. Live Maps configuration is tracked by the parent operator task separately from OAuth configuration and account consent. Parent release tests must verify owner routes, Cloudflare image execution, private photo delivery, local delivery fencing, acknowledgements, offline expiry and reset cleanup. These modules do not qualify a physical tablet or maintained Android firmware.

## Official references

- [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server) describes authorization-code exchange and refresh credentials.
- [Calendar event listing](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) documents the read-only event scope and response filtering.
- [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) and [metadata retrieval](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get) document metadata permissions and selected headers. Search queries are not used with Gmail metadata scope.
- [Open-Meteo forecast documentation](https://open-meteo.com/en/docs) and [pricing](https://open-meteo.com/en/pricing) describe the customer endpoint, commercial use and weather fields.
- [Geocoding requests](https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-geocoding), [Weather daily forecast](https://developers.google.com/maps/documentation/weather/daily-forecast), and [Places Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search) define the fixed request shapes.
- [Geocoding key setup](https://developers.google.com/maps/documentation/geocoding/guides-v3/get-api-key), [Weather key setup](https://developers.google.com/maps/documentation/weather/get-api-key), and [Places key setup](https://developers.google.com/maps/documentation/places/web-service/get-api-key) cover operator configuration.
- [jpeg-js](https://github.com/jpeg-js/jpeg-js) documents decoder memory and resolution controls. [pngjs](https://github.com/pngjs/pngjs) provides the pinned pixel decoding and encoding implementation.
