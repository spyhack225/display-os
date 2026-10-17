package com.displayos.kiosk;

public final class CapturePolicyTest {
    private static int passed;
    static void check(boolean accepted) { if (!accepted) throw new AssertionError(); }
    static void test(String name, Runnable action) { action.run(); passed++; System.out.println("PASS " + name); }
    public static void main(String[] args) {
        test("audio-only without the Android grant asks first", () -> check(CapturePolicy.decide(new String[] { CapturePolicy.AUDIO_CAPTURE }, false) == CapturePolicy.Decision.ASK));
        test("audio-only with the Android grant passes through", () -> check(CapturePolicy.decide(new String[] { CapturePolicy.AUDIO_CAPTURE }, true) == CapturePolicy.Decision.GRANT));
        test("missing, mixed and foreign resources are denied", () -> {
            check(CapturePolicy.decide(null, true) == CapturePolicy.Decision.DENY);
            check(CapturePolicy.decide(new String[0], true) == CapturePolicy.Decision.DENY);
            check(CapturePolicy.decide(new String[] { CapturePolicy.AUDIO_CAPTURE, "android.webkit.resource.VIDEO_CAPTURE" }, true) == CapturePolicy.Decision.DENY);
            check(CapturePolicy.decide(new String[] { "android.webkit.resource.VIDEO_CAPTURE" }, true) == CapturePolicy.Decision.DENY);
            check(CapturePolicy.decide(new String[] { CapturePolicy.AUDIO_CAPTURE, CapturePolicy.AUDIO_CAPTURE }, true) == CapturePolicy.Decision.DENY);
            check(CapturePolicy.decide(new String[] { null }, true) == CapturePolicy.Decision.DENY);
        });
        System.out.println(passed + " capture policy checks passed.");
    }
}
