import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.Signature;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.*;

/**
 * Standalone Java Signing Bridge for Windows Certificate Store (SunMSCAPI)
 * 
 * Supports discovering certificates and performing hardware/software-backed
 * cryptographic signing via Windows CryptoAPI/CNG, which safely prompts the
 * USB DSC token's native PIN dialog without exposing private keys or PINs.
 */
public class SigningBridge {

    private static final SimpleDateFormat ISO_FORMAT = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
    static {
        ISO_FORMAT.setTimeZone(TimeZone.getTimeZone("UTC"));
    }

    public static void main(String[] args) {
        if (args.length == 0) {
            printError("No command specified. Usage: list-certs | sign-data <alias> <dataBase64> | verify-data <certBase64> <dataBase64> <sigBase64>");
            System.exit(1);
        }

        String command = args[0];
        try {
            switch (command) {
                case "list-certs":
                    handleListCerts();
                    break;

                case "sign-data":
                    if (args.length < 3) {
                        printError("Missing arguments for sign-data: <alias> <dataBase64>");
                        System.exit(1);
                    }
                    handleSignData(args[1], args[2]);
                    break;

                case "verify-data":
                    if (args.length < 4) {
                        printError("Missing arguments for verify-data: <certBase64> <dataBase64> <sigBase64>");
                        System.exit(1);
                    }
                    handleVerifyData(args[1], args[2], args[3]);
                    break;

                default:
                    printError("Unknown command: " + command);
                    System.exit(1);
            }
        } catch (Throwable t) {
            printError(t.getMessage() != null ? t.getMessage() : t.toString());
            System.exit(1);
        }
    }

    private static void handleListCerts() throws Exception {
        KeyStore ks = KeyStore.getInstance("Windows-MY");
        ks.load(null, null);

        List<Map<String, Object>> certList = new ArrayList<>();
        Enumeration<String> aliases = ks.aliases();

        while (aliases.hasMoreElements()) {
            String alias = aliases.nextElement();
            try {
                Certificate rawCert = ks.getCertificate(alias);
                if (!(rawCert instanceof X509Certificate)) {
                    continue;
                }
                X509Certificate cert = (X509Certificate) rawCert;
                boolean hasPrivateKey = ks.isKeyEntry(alias);

                String issuer = cert.getIssuerX500Principal().getName();
                String subject = cert.getSubjectX500Principal().getName();

                // Detect Windows internal / Azure AD Workplace Join machine certificates
                boolean isSystemCert = issuer.contains("MS-Organization-Access") ||
                                       issuer.contains("Microsoft Windows") ||
                                       subject.matches(".*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}.*");

                boolean[] keyUsage = cert.getKeyUsage();
                // RFC 5280 keyUsage:
                // 0: digitalSignature, 1: nonRepudiation
                boolean hasSignUsage = (keyUsage != null) && (
                    (keyUsage.length > 0 && keyUsage[0]) ||
                    (keyUsage.length > 1 && keyUsage[1])
                );
                boolean canSign = !isSystemCert && (hasSignUsage || (keyUsage == null && hasPrivateKey));
                boolean isExpired = cert.getNotAfter().before(new Date());
                boolean notYetValid = cert.getNotBefore().after(new Date());

                Map<String, Object> certInfo = new LinkedHashMap<>();
                certInfo.put("alias", alias);
                certInfo.put("subject", subject);
                certInfo.put("issuer", issuer);
                certInfo.put("serialNumber", cert.getSerialNumber().abs().toString(16).toUpperCase());
                certInfo.put("validFrom", ISO_FORMAT.format(cert.getNotBefore()));
                certInfo.put("validTo", ISO_FORMAT.format(cert.getNotAfter()));
                certInfo.put("hasPrivateKey", hasPrivateKey);
                certInfo.put("isExpired", isExpired);
                certInfo.put("notYetValid", notYetValid);
                certInfo.put("isSystemCert", isSystemCert);
                certInfo.put("isEligibleForSigning", !isSystemCert && hasPrivateKey && canSign && !isExpired && !notYetValid);
                certInfo.put("keyAlgorithm", cert.getPublicKey().getAlgorithm());
                certInfo.put("keySize", getKeySize(cert.getPublicKey()));
                certInfo.put("thumbprint", getThumbprint(cert));
                certInfo.put("certDerBase64", Base64.getEncoder().encodeToString(cert.getEncoded()));

                certList.add(certInfo);
            } catch (Exception ex) {
                // Skip problematic certificate entry
            }
        }

        StringBuilder sb = new StringBuilder();
        sb.append("{\"success\":true,\"certificates\":[");
        for (int i = 0; i < certList.size(); i++) {
            if (i > 0) sb.append(",");
            sb.append(mapToJson(certList.get(i)));
        }
        sb.append("]}");

        System.out.println(sb.toString());
    }

    private static void handleSignData(String alias, String dataBase64) throws Exception {
        KeyStore ks = KeyStore.getInstance("Windows-MY");
        ks.load(null, null);

        if (!ks.containsAlias(alias)) {
            printError("Certificate alias not found in Windows-MY store: " + alias);
            return;
        }

        if (!ks.isKeyEntry(alias)) {
            printError("Certificate has no accessible private key: " + alias);
            return;
        }

        PrivateKey privateKey = (PrivateKey) ks.getKey(alias, null);
        if (privateKey == null) {
            printError("Could not retrieve private key handle for alias: " + alias);
            return;
        }

        Certificate cert = ks.getCertificate(alias);
        byte[] data = Base64.getDecoder().decode(dataBase64);

        // Standard SHA256withRSA signature
        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initSign(privateKey);
        sig.update(data);
        byte[] signatureBytes = sig.sign();

        String sigBase64 = Base64.getEncoder().encodeToString(signatureBytes);
        String certBase64 = Base64.getEncoder().encodeToString(cert.getEncoded());

        System.out.println("{\"success\":true,\"signatureBase64\":\"" + sigBase64 + "\",\"certBase64\":\"" + certBase64 + "\",\"algorithm\":\"SHA256withRSA\"}");
    }

    private static void handleVerifyData(String certBase64, String dataBase64, String sigBase64) throws Exception {
        byte[] certBytes = Base64.getDecoder().decode(certBase64);
        byte[] data = Base64.getDecoder().decode(dataBase64);
        byte[] sigBytes = Base64.getDecoder().decode(sigBase64);

        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        X509Certificate cert = (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(certBytes));

        Signature sig = Signature.getInstance("SHA256withRSA");
        sig.initVerify(cert.getPublicKey());
        sig.update(data);
        boolean valid = sig.verify(sigBytes);

        System.out.println("{\"success\":true,\"valid\":" + valid + "}");
    }

    private static int getKeySize(PublicKey pk) {
        if (pk instanceof java.security.interfaces.RSAKey) {
            return ((java.security.interfaces.RSAKey) pk).getModulus().bitLength();
        }
        return 0;
    }

    private static String getThumbprint(X509Certificate cert) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] der = cert.getEncoded();
            md.update(der);
            byte[] digest = md.digest();
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) {
                hex.append(String.format("%02X", b));
            }
            return hex.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private static void printError(String message) {
        String escaped = message.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", "");
        System.out.println("{\"success\":false,\"error\":\"" + escaped + "\"}");
    }

    private static String mapToJson(Map<String, Object> map) {
        StringBuilder sb = new StringBuilder();
        sb.append("{");
        boolean first = true;
        for (Map.Entry<String, Object> entry : map.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(entry.getKey()).append("\":");
            Object val = entry.getValue();
            if (val == null) {
                sb.append("null");
            } else if (val instanceof Boolean || val instanceof Number) {
                sb.append(val);
            } else {
                String s = val.toString().replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "");
                sb.append("\"").append(s).append("\"");
            }
        }
        sb.append("}");
        return sb.toString();
    }
}
