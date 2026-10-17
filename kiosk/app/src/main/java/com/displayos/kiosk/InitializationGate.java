package com.displayos.kiosk;

public final class InitializationGate {
    private int epoch;
    private boolean destroyed;
    public synchronized int begin() {
        if (destroyed) throw new IllegalStateException("Activity initialization has ended.");
        return ++epoch;
    }
    public synchronized boolean current(int expected) { return !destroyed && expected == epoch; }
    public synchronized void destroy() { destroyed = true; epoch++; }
}
