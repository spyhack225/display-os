package com.displayos.kiosk;

public final class CapturePolicy {
    private CapturePolicy() { }
    static final String AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE";
    public enum Decision { GRANT, ASK, DENY }
    public static Decision decide(String[] resources, boolean granted) {
        boolean audioOnly = resources != null && resources.length == 1 && AUDIO_CAPTURE.equals(resources[0]);
        if (!audioOnly) return Decision.DENY;
        return granted ? Decision.GRANT : Decision.ASK;
    }
}
