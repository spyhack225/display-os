package com.displayos.kiosk;

public final class ClaimPolicy {
    private ClaimPolicy() { }
    public static boolean pinFormat(String pin) { return pin != null && pin.matches("(?:[0-9]{6}|[0-9]{8,12})"); }
    public static boolean current(String state, String phrase, long expiresAt, String expectedPhrase, long expectedExpiry, long now) {
        return "confirm".equals(state) && expectedPhrase != null && !expectedPhrase.isEmpty() && expectedPhrase.equals(phrase) && expiresAt == expectedExpiry && expiresAt > now && expiresAt - now <= 120000L;
    }
    public static long waitMillis(long expiresAt, long now) { return Math.max(0L, Math.min(90000L, expiresAt - now - 15000L)); }
}
