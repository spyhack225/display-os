package com.displayos.kiosk;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.security.interfaces.ECPublicKey;

public final class Identity {
    private static final String ALIAS = "displayos-unit-identity-v1";
    private final KeyStore keys;
    public Identity() throws Exception {
        keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (!keys.containsAlias(ALIAS)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY).setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).build());
            generator.generateKeyPair();
        }
    }
    public static String encode(byte[] value) { return Base64.encodeToString(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING); }
    public JSONObject publicKey() throws Exception {
        ECPublicKey key = (ECPublicKey) keys.getCertificate(ALIAS).getPublicKey();
        return new JSONObject().put("kty", "EC").put("crv", "P-256").put("x", encode(SignatureCodec.coordinate(key.getW().getAffineX()))).put("y", encode(SignatureCodec.coordinate(key.getW().getAffineY())));
    }
    public String signTicket(String ticket) throws Exception {
        return signMessage(ticket);
    }
    public String signMessage(String message) throws Exception {
        Signature signature = Signature.getInstance("SHA256withECDSA");
        signature.initSign((PrivateKey) keys.getKey(ALIAS, null)); signature.update(message.getBytes(StandardCharsets.UTF_8));
        return encode(SignatureCodec.raw(signature.sign()));
    }
    public boolean hardwareBacked() throws Exception {
        PrivateKey key = (PrivateKey) keys.getKey(ALIAS, null);
        return KeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class).isInsideSecureHardware();
    }
}
