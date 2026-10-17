package com.displayos.kiosk;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public final class Protocol {
    private final String origin;
    private static final Set<String> POSTS = new HashSet<String>(Arrays.asList("/device/v1/pairing", "/device/v1/confirm", "/device/v1/ack", "/device/v1/erase", "/device/v1/lists", "/device/v1/voice"));
    public Protocol(String value) {
        URI uri = URI.create(value);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath().isEmpty() || "/".equals(uri.getPath())) || uri.getPort() != -1) throw new IllegalArgumentException("An exact HTTPS origin with default port is required.");
        origin = "https://" + uri.getHost();
        if (!origin.equals(value)) throw new IllegalArgumentException("Origin must be canonical.");
    }
    public String origin() { return origin; }
    public String path(String address) {
        try {
            URI uri = URI.create(address);
            if (!"https".equals(uri.getScheme()) || uri.getRawAuthority() == null || !origin.equals("https://" + uri.getRawAuthority()) || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) return null;
            String path = uri.getRawPath();
            if (!path.equals(uri.normalize().getRawPath()) || path.contains("%") || path.contains("\\") || path.contains("//")) return null;
            return path;
        } catch (RuntimeException error) { return null; }
    }
    public boolean navigation(String address) { return "/screen".equals(path(address)); }
    public boolean publicAsset(String path) { return "/screen".equals(path) || path != null && path.matches("/product/[A-Za-z0-9_./-]+") && !path.contains(".."); }
    public boolean deviceGet(String path) { return "/device/v1/poll".equals(path) || "/device/v1/local".equals(path); }
    public boolean devicePost(String path) { return POSTS.contains(path); }
    public String mediaId(String path) {
        String prefix = "/device/v1/media/";
        if (path == null || !path.startsWith(prefix)) return null;
        String id = path.substring(prefix.length());
        return id.matches("[A-Za-z0-9_-]{8,128}") ? id : null;
    }
    public boolean bearerAllowed(String path, String method) {
        return "GET".equals(method) && (deviceGet(path) || mediaId(path) != null) || "POST".equals(method) && devicePost(path);
    }
    public static boolean active(long expiresAt, long fetchedAt, long now) {
        return expiresAt > now && expiresAt > fetchedAt && expiresAt - fetchedAt <= 86400000L && now >= fetchedAt - 300000L;
    }
    public static void requirePin(String pin) {
        if (!ClaimPolicy.pinFormat(pin)) throw new IllegalArgumentException("Use a 6 digit PIN or an existing 8 to 12 digit legacy PIN.");
    }
    public static boolean newPinFormat(String pin) { return pin != null && pin.matches("[0-9]{6}"); }
    public static void requireNewPin(String pin) {
        if (!newPinFormat(pin)) throw new IllegalArgumentException("Choose exactly 6 numbers for a new owner PIN.");
    }
}
