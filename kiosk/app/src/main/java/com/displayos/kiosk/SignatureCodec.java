package com.displayos.kiosk;

import java.math.BigInteger;
import java.util.Arrays;

public final class SignatureCodec {
    private SignatureCodec() {}
    public static byte[] coordinate(BigInteger number) {
        byte[] raw = number.toByteArray();
        if (number.signum() < 0 || number.bitLength() > 256) throw new IllegalArgumentException("Invalid P-256 coordinate.");
        byte[] result = new byte[32];
        int size = Math.min(32, raw.length);
        System.arraycopy(raw, raw.length - size, result, 32 - size, size);
        return result;
    }
    public static byte[] raw(byte[] der) {
        if (der.length < 8 || der.length > 72 || der[0] != 0x30 || (der[1] & 255) != der.length - 2) throw new IllegalArgumentException("Invalid ECDSA sequence.");
        int firstLength = der[3] & 255;
        int secondOffset = 4 + firstLength;
        if (der[2] != 2 || firstLength < 1 || firstLength > 33 || secondOffset + 2 >= der.length || der[secondOffset] != 2) throw new IllegalArgumentException("Invalid ECDSA integer.");
        int secondLength = der[secondOffset + 1] & 255;
        if (secondLength < 1 || secondLength > 33 || secondOffset + 2 + secondLength != der.length) throw new IllegalArgumentException("Invalid ECDSA length.");
        byte[] result = new byte[64];
        byte[] first = coordinate(new BigInteger(Arrays.copyOfRange(der, 4, secondOffset)));
        byte[] second = coordinate(new BigInteger(Arrays.copyOfRange(der, secondOffset + 2, der.length)));
        System.arraycopy(first, 0, result, 0, 32); System.arraycopy(second, 0, result, 32, 32);
        return result;
    }
}
