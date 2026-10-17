package com.displayos.kiosk;

import java.util.Iterator;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

public final class LocalContent {
    private LocalContent() { }
    private static void fields(JSONObject value, String... names) {
        Set<String> allowed = new HashSet<String>(Arrays.asList(names));
        Iterator<String> keys = value.keys();
        while (keys.hasNext()) if (!allowed.contains(keys.next())) throw new SecurityException("Unexpected local data field.");
    }
    private static String text(JSONObject value, String name, int maximum) throws Exception {
        Object input = value.get(name);
        if (!(input instanceof String)) throw new SecurityException("Local text must be a string.");
        String result = (String) input;
        if (result.length() > maximum || result.matches("(?s).*[<>\\p{Cntrl}].*")) throw new SecurityException("Unsafe local text.");
        return result;
    }
    private static double temperature(JSONObject value, String name) throws Exception {
        Object input = value.get(name);
        if (!(input instanceof Number)) throw new SecurityException("Local temperature must be numeric.");
        double result = ((Number) input).doubleValue();
        if (Double.isNaN(result) || Double.isInfinite(result) || result < -100 || result > 100) throw new SecurityException("Local temperature is out of bounds.");
        return result;
    }
    private static boolean flag(JSONObject value, String name) throws Exception {
        Object input = value.get(name);
        if (!(input instanceof Boolean)) throw new SecurityException("Local flag must be boolean.");
        return (Boolean) input;
    }
    private static long integer(JSONObject value, String name) throws Exception {
        Object input = value.get(name);
        if (!(input instanceof Number)) throw new SecurityException("Local metadata must be numeric.");
        double result = ((Number) input).doubleValue();
        if (Double.isNaN(result) || Double.isInfinite(result) || result < 0 || result > 9007199254740991D || result != Math.floor(result)) throw new SecurityException("Local metadata must be a safe nonnegative integer.");
        return (long) result;
    }
    private static String exactText(JSONObject value, String name, String expected) throws Exception {
        String result = text(value, name, expected.length());
        if (!expected.equals(result)) throw new SecurityException("Unexpected local attribution.");
        return result;
    }
    public static String sanitize(String input) throws Exception {
        return sanitize(input, System.currentTimeMillis());
    }
    static String sanitize(String input, long now) throws Exception {
        JSONObject source = new JSONObject(input);
        fields(source, "available", "localEnabled", "localRevision", "cityLabel", "weather", "nearby", "attribution", "thirdPartyAttributions", "expiresAt", "ephemeral", "weatherSourceAttribution");
        boolean available = flag(source, "available");
        JSONObject enabled = source.getJSONObject("localEnabled");
        fields(enabled, "weather", "nearby");
        JSONObject cleanEnabled = new JSONObject().put("weather", flag(enabled, "weather")).put("nearby", flag(enabled, "nearby"));
        JSONObject result = new JSONObject().put("available", available).put("localEnabled", cleanEnabled).put("localRevision", integer(source, "localRevision"));
        JSONArray weather = source.has("weather") ? source.getJSONArray("weather") : new JSONArray();
        JSONArray nearby = source.has("nearby") ? source.getJSONArray("nearby") : new JSONArray();
        if (!available) {
            fields(source, "available", "localEnabled", "localRevision", "weather", "nearby");
            if (weather.length() != 0 || nearby.length() != 0) throw new SecurityException("Unavailable local data cannot contain rows.");
            return result.put("weather", new JSONArray()).put("nearby", new JSONArray()).toString();
        }
        long expiresAt = integer(source, "expiresAt");
        if (expiresAt <= now || expiresAt - now > 3630000L || !flag(source, "ephemeral")) throw new SecurityException("Local data must be live and ephemeral.");
        JSONArray thirdParty = source.getJSONArray("thirdPartyAttributions");
        if (thirdParty.length() != 0) throw new SecurityException("Unexpected third-party attribution data.");
        result.put("cityLabel", text(source, "cityLabel", 80)).put("attribution", exactText(source, "attribution", "Google Maps")).put("thirdPartyAttributions", new JSONArray()).put("expiresAt", Math.min(expiresAt, now + 3600000L)).put("ephemeral", true);
        if (weather.length() > 0 || source.has("weatherSourceAttribution")) result.put("weatherSourceAttribution", exactText(source, "weatherSourceAttribution", "Source: Includes weather data from Google"));
        if (weather.length() > 7) throw new SecurityException("Too many local weather rows.");
        JSONArray cleanWeather = new JSONArray();
        for (int index = 0; index < weather.length(); index++) {
            JSONObject row = weather.getJSONObject(index); fields(row, "date", "label", "high", "low", "condition");
            String date = text(row, "date", 10);
            if (!date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new SecurityException("Invalid weather date.");
            cleanWeather.put(new JSONObject().put("date", date).put("label", text(row, "label", 80)).put("high", temperature(row, "high")).put("low", temperature(row, "low")).put("condition", text(row, "condition", 80)));
        }
        if (nearby.length() > 3) throw new SecurityException("Too many nearby rows.");
        JSONArray cleanNearby = new JSONArray();
        for (int index = 0; index < nearby.length(); index++) {
            JSONObject row = nearby.getJSONObject(index); fields(row, "title", "when");
            cleanNearby.put(new JSONObject().put("title", text(row, "title", 80)).put("when", text(row, "when", 80)));
        }
        return result.put("weather", cleanWeather).put("nearby", cleanNearby).toString();
    }
}
