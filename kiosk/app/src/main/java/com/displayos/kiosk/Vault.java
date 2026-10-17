package com.displayos.kiosk;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Set;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class Vault {
    private static final String ALIAS = "displayos-private-storage-v1";
    private final File directory;
    private final SecretKey key;
    public Vault(Context context) throws Exception {
        directory = new File(context.getNoBackupFilesDir(), "private-store");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Private storage unavailable.");
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (!keys.containsAlias(ALIAS)) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());
            generator.generateKey();
        }
        key = (SecretKey) keys.getKey(ALIAS, null);
    }
    private AtomicFile file(String name) {
        if (!name.matches("[a-zA-Z0-9_-]{1,100}")) throw new IllegalArgumentException("Invalid private record name.");
        return new AtomicFile(new File(directory, name));
    }
    public synchronized void put(String name, byte[] plaintext) throws Exception {
        if (plaintext.length > 2097152) throw new IllegalArgumentException("Private record too large.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key); cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(plaintext);
        byte[] record = ByteBuffer.allocate(1 + 12 + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array();
        AtomicFile target = file(name); FileOutputStream output = target.startWrite();
        try { output.write(record); target.finishWrite(output); } catch (Exception error) { target.failWrite(output); throw error; }
    }
    public synchronized byte[] get(String name) throws Exception {
        AtomicFile target = file(name);
        if (!target.getBaseFile().exists()) return null;
        if (target.getBaseFile().length() > 2097200) { target.delete(); throw new IllegalStateException("Private record exceeds limit."); }
        byte[] record = target.readFully();
        if (record.length < 29 || record[0] != 1) throw new IllegalStateException("Invalid private record.");
        byte[] nonce = new byte[12]; System.arraycopy(record, 1, nonce, 0, 12);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, nonce)); cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return cipher.doFinal(record, 13, record.length - 13);
    }
    public synchronized void delete(String name) { file(name).delete(); }
    public synchronized void retain(String prefix, Set<String> names) {
        File[] files = directory.listFiles(); if (files == null) throw new IllegalStateException("Cannot inspect private cache.");
        for (File item : files) if (item.getName().startsWith(prefix) && !names.contains(item.getName())) {
            if (!item.delete() && item.exists()) throw new IllegalStateException("Cannot remove unapproved private cache.");
        }
    }
    public synchronized void clearContent() {
        File[] files = directory.listFiles();
        if (files == null) throw new IllegalStateException("Cannot inspect private cache.");
        for (File item : files) if (!item.getName().equals("configuration") && !item.getName().equals("configuration.bak")) {
            if (!item.delete() && item.exists()) throw new IllegalStateException("Cannot erase private cache.");
        }
    }
}
