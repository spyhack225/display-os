package com.displayos.kiosk;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.admin.DevicePolicyManager;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class MainActivity extends Activity implements NativeClient.Observer {
    private static final int CAPTURE_PERMISSION = 102;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService commands = Executors.newSingleThreadExecutor();
    private final AtomicInteger outstanding = new AtomicInteger();
    private final InitializationGate initialization = new InitializationGate();
    private Protocol protocol;
    private volatile NativeClient client;
    private WebView browser;
    private PermissionRequest pendingCapture;
    private FrameLayout surface;
    private TextView warning;
    private volatile WebMessagePort channel;
    private AlertDialog installer;
    private volatile ClaimAttempt pendingClaim;
    private final class ClaimAttempt {
        final WebMessagePort port;
        final int epoch;
        final String id;
        final JSONObject body;
        final NativeClient expected;
        final String phrase;
        final long expiresAt;
        final long deadline;
        AlertDialog dialog;
        EditText pin;
        TextView helper;
        Runnable timeout;
        ClaimAttempt(WebMessagePort port, int epoch, String id, JSONObject body, NativeClient expected, JSONObject state) {
            this.port = port; this.epoch = epoch; this.id = id; this.body = body; this.expected = expected;
            phrase = state.optString("phrase"); expiresAt = state.optLong("expiresAt");
            deadline = android.os.SystemClock.elapsedRealtime() + ClaimPolicy.waitMillis(expiresAt, System.currentTimeMillis());
        }
    }
    private volatile boolean foreground;
    private volatile boolean wiped;
    private volatile int generation;
    private long windowStarted;
    private int windowCommands;
    private final Runnable expiryCheck = new Runnable() {
        @Override public void run() {
            final NativeClient expected = client;
            if (!wiped && expected != null && expected.expiry() > 0 && expected.expiry() <= System.currentTimeMillis()) {
                erased(); commands.execute(() -> { try { synchronized (expected) { if (client == expected && expected.expiry() > 0 && expected.expiry() <= System.currentTimeMillis()) expected.clearContent(); } } catch (Exception ignored) { } });
            }
            handler.postDelayed(this, 1000);
        }
    };
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        KioskAdmin.configureIfOwner(this);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        surface = new FrameLayout(this); surface.setBackgroundColor(Color.rgb(10, 10, 11)); setContentView(surface);
        warning = new TextView(this); warning.setTextColor(Color.WHITE); warning.setPadding(30, 80, 30, 30);
        surface.addView(warning); warning.setText("Starting protected screen...");
        protocol = new Protocol(BuildConfig.ORIGIN);
        initializeClient(true);
        handler.post(expiryCheck);
    }
    private void initializeClient(boolean startup) {
        if (isFinishing() || isDestroyed()) return;
        final int epoch = initialization.begin();
        final Protocol expectedProtocol = protocol;
        commands.execute(() -> {
            try {
                if (!initialization.current(epoch)) return;
                if (startup) {
                    java.io.File abandoned = new java.io.File(getFilesDir(), "preparation.json");
                    if (abandoned.exists() && !abandoned.delete()) throw new SecurityException("Abandoned preparation cannot be removed.");
                }
                final NativeClient candidate = new NativeClient(this, expectedProtocol);
                if (!initialization.current(epoch)) return;
                candidate.resumePending();
                runOnUiThread(() -> {
                    if (!initialization.current(epoch) || isFinishing() || isDestroyed()) return;
                    client = candidate; observe(candidate);
                    if (candidate.prepared()) openScreen(); else preparation();
                });
            } catch (Exception error) { runOnUiThread(() -> {
                if (!initialization.current(epoch) || isFinishing() || isDestroyed()) return;
                warning.setText("Protected storage or service configuration failed. Do not clear this app's data: its unit identity is required for recovery.");
            }); }
        });
    }
    private EditText field(String hint, boolean secret) {
        EditText field = new EditText(this); field.setHint(hint);
        field.setSingleLine(true); field.setInputType(secret ? InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD : InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS); return field;
    }
    private void preparation() {
        warning.setText("Local installer preparation required. Export the native unit public key first. No account or factory credential belongs on this screen.");
        LinearLayout fields = new LinearLayout(this); fields.setOrientation(LinearLayout.VERTICAL);
        EditText ticket = field("Single-use per-unit ticket", false); EditText pin = field("Owner PIN (6 digits; legacy 8 to 12)", true);
        fields.addView(ticket); fields.addView(pin);
        installer = new AlertDialog.Builder(this).setTitle("Prepare this unit locally").setMessage("The ticket must match this installation's native public key. Choose a PIN with the owner. An expired ticket requires a new factory ticket.").setView(fields).setCancelable(false)
            .setPositiveButton("Enroll", (dialog, which) -> {
                String suppliedTicket = ticket.getText().toString(); String suppliedPin = pin.getText().toString(); ticket.setText(""); pin.setText("");
                commands.execute(() -> { try { client.prepare(suppliedTicket, suppliedPin); runOnUiThread(this::openScreen); } catch (Exception error) { runOnUiThread(() -> new AlertDialog.Builder(this).setMessage("Enrollment failed. Check network, ticket expiry, and matching native public key. No credential details are displayed.").setPositiveButton("Retry", (retry, selected) -> preparation()).show()); } });
            }).setNeutralButton("Wi-Fi", (dialog, which) -> { startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); handler.postDelayed(this::preparation, 1000); }).show();
    }
    private void openScreen() {
        if (isFinishing() || isDestroyed() || client == null || !client.prepared()) return;
        cancelClaim(409);
        if (installer != null) { installer.dismiss(); installer = null; }
        if (channel != null) { channel.close(); channel = null; }
        if (browser != null) { surface.removeView(browser); browser.stopLoading(); browser.destroy(); }
        if (pendingCapture != null) { try { pendingCapture.deny(); } catch (RuntimeException ignored) { } pendingCapture = null; }
        generation++; wiped = false;
        browser = new WebView(this);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings settings = browser.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(false); settings.setMediaPlaybackRequiresUserGesture(true); settings.setSaveFormData(false);
        settings.setGeolocationEnabled(false); settings.setSafeBrowsingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(false); CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);
        browser.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        browser.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return !request.isForMainFrame() || !protocol.navigation(request.getUrl().toString()); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !protocol.navigation(url); }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return intercept(request); }
            @Override public void onPageFinished(WebView view, String url) { if (view == browser && protocol.navigation(url) && !wiped) attachPort(view); }
            @Override public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler decision, android.net.http.SslError error) { decision.cancel(); }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) { surface.removeView(view); view.destroy(); if (view == browser) browser = null; erased(); return true; }
        });
        browser.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                String[] resources = request.getResources();
                runOnUiThread(() -> {
                    CapturePolicy.Decision decision = CapturePolicy.decide(resources, checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
                    if (decision == CapturePolicy.Decision.GRANT) { request.grant(resources); return; }
                    if (decision == CapturePolicy.Decision.DENY) { request.deny(); return; }
                    if (pendingCapture != null) { try { pendingCapture.deny(); } catch (RuntimeException ignored) { } }
                    pendingCapture = request;
                    requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, CAPTURE_PERMISSION);
                });
            }
        });
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setBlockNetworkLoads(true);
        ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) { return denied(403); }
        });
        browser.setDownloadListener((url, agent, disposition, mime, length) -> { });
        surface.addView(browser, 0, new FrameLayout.LayoutParams(-1, -1)); warning.setVisibility(View.GONE);
        Button controls = new Button(this); controls.setText("Owner controls");
        controls.setOnClickListener(view -> ownerControls());
        FrameLayout.LayoutParams position = new FrameLayout.LayoutParams(-2, -2, android.view.Gravity.BOTTOM | android.view.Gravity.END);
        if (surface.getChildCount() > 2) surface.removeViewAt(surface.getChildCount() - 1);
        surface.addView(controls, position);
        browser.loadUrl(protocol.origin() + "/screen");
        applyImmersive();
        DevicePolicyManager manager = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
        if (manager != null && manager.isLockTaskPermitted(getPackageName())) startLockTask();
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != CAPTURE_PERMISSION || pendingCapture == null) return;
        PermissionRequest request = pendingCapture; pendingCapture = null;
        boolean granted = results != null && results.length == 1 && results[0] == PackageManager.PERMISSION_GRANTED;
        runOnUiThread(() -> { try { if (granted) request.grant(request.getResources()); else request.deny(); } catch (RuntimeException ignored) { } });
    }
    private WebResourceResponse denied(int status) { return response(new NativeHttp.Reply(status, "application/json", "{}".getBytes(StandardCharsets.UTF_8))); }
    private WebResourceResponse response(NativeHttp.Reply reply) {
        Map<String, String> headers = new HashMap<String, String>(); headers.put("Cache-Control", "no-store"); headers.put("X-Content-Type-Options", "nosniff");
        headers.put("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src " + protocol.origin() + "; img-src blob: data:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return new WebResourceResponse(reply.mime, "UTF-8", reply.status, reply.status < 400 ? "OK" : "Denied", headers, new ByteArrayInputStream(reply.data));
    }
    private WebResourceResponse intercept(WebResourceRequest request) {
        String path = protocol.path(request.getUrl().toString());
        if (path == null || !"GET".equals(request.getMethod()) || request.isForMainFrame() && !"/screen".equals(path)) return denied(403);
        try {
            if ("/product/kiosk-native-transport.js".equals(path)) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream input = getAssets().open("kiosk-native-transport.js")) { byte[] buffer = new byte[4096]; int count; while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count); }
                return response(new NativeHttp.Reply(200, "text/javascript", bytes.toByteArray()));
            }
            if ("/device/v1/local".equals(path)) return response(client.local());
            if (protocol.deviceGet(path)) return response(client.poll());
            if (protocol.mediaId(path) != null) return response(client.media(path));
            if (protocol.publicAsset(path)) {
                NativeHttp.Reply asset = client.asset(path);
                if ("/screen".equals(path) && asset.status == 200) {
                    String html = asset.text();
                    if (!html.contains("<head>")) return denied(502);
                    html = html.replace("<head>", "<head><script src=\"/product/kiosk-native-transport.js\"></script>");
                    asset = new NativeHttp.Reply(200, "text/html", html.getBytes(StandardCharsets.UTF_8));
                }
                return response(asset);
            }
        } catch (SecurityException error) { return denied(403); } catch (Exception error) { return denied(503); }
        return denied(403);
    }
    private void attachPort(WebView view) {
        if (channel != null) return;
        WebMessagePort[] ports = view.createWebMessageChannel(); channel = ports[0];
        final WebMessagePort source = channel; final int epoch = generation;
        source.setWebMessageCallback(new WebMessagePort.WebMessageCallback() {
            @Override public void onMessage(WebMessagePort port, WebMessage message) {
                if (epoch != generation || wiped || !foreground || browser == null || !protocol.navigation(browser.getUrl())) return;
                String data = message.getData(); if (data == null || data.length() > 8192 || message.getPorts() != null && message.getPorts().length != 0) return;
                try {
                    JSONObject packet = new JSONObject(data); String id = packet.getString("id"); String path = packet.getString("path"); JSONObject body = packet.getJSONObject("body");
                    if (packet.length() != 3 || !id.matches("[0-9]{1,9}") || !protocol.devicePost(path)) throw new SecurityException();
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (now - windowStarted > 60000) { windowStarted = now; windowCommands = 0; }
                    if (++windowCommands > 120 || outstanding.get() >= 8) { reply(source, epoch, id, 429, new JSONObject()); return; }
                    if ("/device/v1/confirm".equals(path)) confirmClaim(source, epoch, id, body);
                    else dispatch(source, epoch, id, path, body);
                } catch (Exception ignored) { }
            }
        }, handler);
        view.postWebMessage(new WebMessage("displayos-native-port-v1", new WebMessagePort[] { ports[1] }), Uri.parse(protocol.origin()));
    }
    private void reply(WebMessagePort port, int epoch, String id, int status, JSONObject body) {
        runOnUiThread(() -> { if (epoch != generation || port != channel) return; try { port.postMessage(new WebMessage(new JSONObject().put("id", id).put("status", status).put("body", body).toString())); } catch (Exception ignored) { } });
    }
    private void dispatch(WebMessagePort port, int epoch, String id, String path, JSONObject body) {
        dispatch(port, epoch, id, path, body, 0L);
    }
    private void dispatch(WebMessagePort port, int epoch, String id, String path, JSONObject body, long claimExpiry) {
        if ("/device/v1/ack".equals(path) && (!foreground || browser == null || !browser.isShown() || !browser.hasWindowFocus())) { reply(port, epoch, id, 409, new JSONObject()); return; }
        final NativeClient expected = client;
        outstanding.incrementAndGet();
        commands.execute(() -> {
            try {
                if (epoch != generation || !foreground || wiped || expected != client || port != channel) { reply(port, epoch, id, 409, new JSONObject()); return; }
                NativeHttp.Reply result = expected.post(path, body, claimExpiry, () -> epoch == generation && foreground && !wiped && expected == client && port == channel); reply(port, epoch, id, result.status, new JSONObject(result.text()));
            } catch (SecurityException error) { reply(port, epoch, id, 403, new JSONObject()); } catch (Exception error) { reply(port, epoch, id, 503, new JSONObject()); }
            finally { outstanding.decrementAndGet(); }
        });
    }
    private boolean claimWorkerCurrent(ClaimAttempt attempt) {
        return pendingClaim == attempt && client == attempt.expected && foreground && !wiped && attempt.epoch == generation && attempt.port == channel && android.os.SystemClock.elapsedRealtime() < attempt.deadline;
    }
    private boolean claimCurrent(ClaimAttempt attempt) {
        if (!claimWorkerCurrent(attempt) || browser == null || !protocol.navigation(browser.getUrl())) return false;
        JSONObject state = attempt.expected.state();
        return state != null && ClaimPolicy.current(state.optString("state"), state.optString("phrase"), state.optLong("expiresAt"), attempt.phrase, attempt.expiresAt, System.currentTimeMillis());
    }
    private void finishClaim(ClaimAttempt attempt, int status) {
        if (pendingClaim != attempt) return;
        pendingClaim = null; outstanding.decrementAndGet();
        handler.removeCallbacks(attempt.timeout);
        attempt.pin.setText(""); attempt.dialog.dismiss();
        if (status != 0) reply(attempt.port, attempt.epoch, attempt.id, status, new JSONObject());
    }
    private void cancelClaim(int status) { if (pendingClaim != null) finishClaim(pendingClaim, status); }
    private void confirmClaim(WebMessagePort port, int epoch, String id, JSONObject body) {
        if (pendingClaim != null) { reply(port, epoch, id, 409, new JSONObject()); return; }
        NativeClient expected = client; JSONObject state = expected.state();
        if (state == null || body.length() != 1 || !(body.opt("phrase") instanceof String) || !ClaimPolicy.current(state.optString("state"), state.optString("phrase"), state.optLong("expiresAt"), body.optString("phrase"), state.optLong("expiresAt"), System.currentTimeMillis()) || ClaimPolicy.waitMillis(state.optLong("expiresAt"), System.currentTimeMillis()) == 0) { reply(port, epoch, id, 410, new JSONObject()); return; }
        final ClaimAttempt attempt = new ClaimAttempt(port, epoch, id, body, expected, state);
        LinearLayout fields = new LinearLayout(this); fields.setOrientation(LinearLayout.VERTICAL); fields.setPadding(24, 0, 24, 0);
        attempt.pin = field(expected.hasPin() ? "Your screen PIN" : "Choose a 6-digit screen PIN", true);
        attempt.helper = new TextView(this); attempt.helper.setText(expected.hasPin() ? "Enter your saved screen PIN." : "Choose 6 numbers. This is only for changing or leaving this screen. Keep it private.");
        fields.addView(attempt.pin); fields.addView(attempt.helper);
        attempt.dialog = new AlertDialog.Builder(this).setTitle("Connect this screen to your home").setMessage(state.optString("homeName") + "\n\n" + attempt.phrase + "\n\nContinue only if these words match your phone. Please finish while your phone is waiting.").setView(fields).setNegativeButton("Cancel", null).setPositiveButton("Connect screen", null).create();
        attempt.timeout = () -> finishClaim(attempt, 410);
        pendingClaim = attempt; outstanding.incrementAndGet();
        attempt.dialog.setOnCancelListener(dialog -> finishClaim(attempt, 499));
        attempt.dialog.setOnDismissListener(dialog -> { if (pendingClaim == attempt) finishClaim(attempt, 499); });
        attempt.dialog.show();
        attempt.dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(view -> finishClaim(attempt, 499));
        attempt.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            if (!claimCurrent(attempt)) { finishClaim(attempt, 410); return; }
            String supplied = attempt.pin.getText().toString();
            if (!ClaimPolicy.pinFormat(supplied) || !expected.hasPin() && !Protocol.newPinFormat(supplied)) {
                attempt.helper.setText(expected.hasPin() ? "Enter your saved screen PIN using numbers only." : "Choose exactly 6 numbers, 0 to 9. This PIN is separate from your connection code."); return;
            }
            attempt.pin.setText(""); attempt.pin.setEnabled(false); attempt.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            attempt.helper.setText("Checking PIN securely...");
            commands.execute(() -> {
                boolean accepted = false; boolean failed = false;
                try {
                    if (!claimWorkerCurrent(attempt)) throw new SecurityException();
                    accepted = expected.verifyClaimPin(supplied, attempt.phrase, attempt.expiresAt, () -> claimWorkerCurrent(attempt));
                } catch (Exception error) { failed = true; }
                final boolean valid = accepted; final boolean saveFailed = failed;
                runOnUiThread(() -> {
                    if (pendingClaim != attempt) return;
                    if (!claimCurrent(attempt)) { finishClaim(attempt, 410); return; }
                    if (valid) { finishClaim(attempt, 0); dispatch(port, epoch, id, "/device/v1/confirm", body, attempt.expiresAt); return; }
                    attempt.pin.setEnabled(true); attempt.pin.setHint(expected.hasPin() ? "Your screen PIN" : "Choose a 6-digit screen PIN");
                    attempt.dialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
                    long wait = expected.pinRetryAfterMillis();
                    attempt.helper.setText(wait > 0 ? "Too many attempts. Please wait " + ((wait + 999) / 1000) + " seconds before trying again." : saveFailed ? "That didn't save. Please try again." : "That PIN didn't match. Please try again.");
                });
            });
        });
        handler.postDelayed(attempt.timeout, ClaimPolicy.waitMillis(attempt.expiresAt, System.currentTimeMillis()));
    }
    private void notice(String text) { new AlertDialog.Builder(this).setMessage(text).setPositiveButton("OK", null).show(); }
    private void observe(final NativeClient expected) {
        expected.observe(new NativeClient.Observer() {
            @Override public void changed(JSONObject state) { if (client == expected) MainActivity.this.changed(state); }
            @Override public void erased() { if (client == expected) MainActivity.this.erased(); }
        });
    }
    private void ownerControls() {
        if (client == null) { notice("Protected preparation is still loading."); return; }
        if (!client.hasPin()) {
            JSONObject state = client.state();
            if (state != null && "unclaimed".equals(state.optString("state"))) new AlertDialog.Builder(this).setMessage("This screen is unclaimed. Complete home confirmation to create its owner PIN.").setPositiveButton("Repair Wi-Fi", (dialog, choice) -> { try { stopLockTask(); } catch (RuntimeException ignored) { } startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); }).setNegativeButton("Cancel", null).show();
            else notice("Complete physical home confirmation to create the owner PIN.");
            return;
        }
        EditText pin = field("Owner PIN", true);
        new AlertDialog.Builder(this).setTitle("Owner controls").setView(pin).setNegativeButton("Cancel", null).setPositiveButton("Unlock", (dialog, which) -> {
            String supplied = pin.getText().toString(); pin.setText("");
            commands.execute(() -> { try { boolean accepted = client.verifyPin(supplied); runOnUiThread(() -> { if (accepted) controlsMenu(); else notice("PIN not accepted."); }); } catch (Exception error) { runOnUiThread(() -> notice("Owner controls temporarily locked.")); } });
        }).show();
    }
    private void controlsMenu() {
        new AlertDialog.Builder(this).setTitle("Owner controls").setItems(new String[] { "Repair Wi-Fi", "Choose default Home", "Exit kiosk", "Reset instructions" }, (dialog, choice) -> {
            if (choice == 0) { try { stopLockTask(); } catch (RuntimeException ignored) { } startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)); }
            else if (choice == 1) { try { stopLockTask(); } catch (RuntimeException ignored) { } startActivity(new Intent(Settings.ACTION_HOME_SETTINGS)); }
            else if (choice == 2) {
                try { stopLockTask(); } catch (RuntimeException ignored) { }
                DevicePolicyManager manager = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
                if (manager != null && manager.isDeviceOwnerApp(getPackageName())) {
                    manager.clearPackagePersistentPreferredActivities(new android.content.ComponentName(this, KioskAdmin.class), getPackageName());
                    startActivity(new Intent(Settings.ACTION_HOME_SETTINGS));
                }
                finishAndRemoveTask();
            }
            else notice("Reset this screen from its signed-in home on your phone. The native app erases private content and rotates its transport credential before another home can claim it. Do not clear app data or delete the unit Keystore key.");
        }).show();
    }
    @Override public void changed(JSONObject state) {
        final NativeClient expected = client;
        runOnUiThread(() -> {
            if (client != expected || expected == null) return;
            if (pendingClaim != null && !claimCurrent(pendingClaim)) cancelClaim(410);
            if (state.has("settings")) {
                JSONObject settings = state.optJSONObject("settings"); if (settings != null) {
                    WindowManager.LayoutParams attributes = getWindow().getAttributes(); attributes.screenBrightness = Math.max(0.1f, Math.min(1f, settings.optInt("brightness", 100) / 100f)); getWindow().setAttributes(attributes);
                    String orientation = settings.optString("orientation", "auto"); setRequestedOrientation("portrait".equals(orientation) ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : "landscape".equals(orientation) ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                }
            }
            if (wiped && !"erase".equals(state.optString("state"))) openScreen();
        });
    }
    @Override public void erased() {
        final NativeClient expected = client;
        runOnUiThread(() -> {
            if (client != expected || expected == null || wiped) return;
            cancelClaim(410);
            wiped = true; generation++;
            if (channel != null) { channel.close(); channel = null; }
            if (browser != null) { browser.stopLoading(); browser.loadUrl("about:blank"); browser.clearCache(true); browser.clearHistory(); browser.setVisibility(View.GONE); }
            warning.setText("Private family data cleared. Reconnecting safely..."); warning.setVisibility(View.VISIBLE);
            handler.postDelayed(() -> { if (wiped && client != null && client.prepared()) openScreen(); }, 5000);
        });
    }
    @Override public void onResume() {
        super.onResume(); foreground = true;
        applyImmersive();
        if (client != null && client.expiry() > 0 && client.expiry() <= System.currentTimeMillis()) erased();
        if (browser != null) {
            browser.onResume(); DevicePolicyManager manager = (DevicePolicyManager) getSystemService(DEVICE_POLICY_SERVICE);
            if (manager != null && manager.isLockTaskPermitted(getPackageName())) startLockTask();
        }
    }
    private void applyImmersive() {
        if (!foreground || pendingClaim != null || installer != null && installer.isShowing()) return;
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) applyImmersive();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        if (isFinishing() || isDestroyed()) return;
        cancelClaim(409);
        generation++; wiped = true; client = null;
        if (channel != null) { channel.close(); channel = null; }
        if (browser != null) { browser.stopLoading(); browser.loadUrl("about:blank"); browser.setVisibility(View.GONE); }
        warning.setText("Reloading protected unit preparation..."); warning.setVisibility(View.VISIBLE);
        initializeClient(false);
    }
    @Override public void onPause() { foreground = false; cancelClaim(409); if (browser != null) browser.onPause(); super.onPause(); }
    @Override public void onBackPressed() { ownerControls(); }
    @Override public void onDestroy() { initialization.destroy(); cancelClaim(409); handler.removeCallbacksAndMessages(null); if (channel != null) channel.close(); if (browser != null) browser.destroy(); commands.shutdownNow(); super.onDestroy(); }
}
