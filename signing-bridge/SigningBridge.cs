using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Linq;

namespace DocumentMerger.SigningBridge
{
    class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
            }
            catch { }

            if (args.Length == 0)
            {
                PrintError("No command specified. Usage: list-certs | sign-data <alias> <dataBase64> | verify-data <certBase64> <dataBase64> <sigBase64>");
                return 1;
            }

            string command = args[0];
            try
            {
                if (command == "list-certs")
                {
                    return HandleListCerts();
                }
                else if (command == "sign-data")
                {
                    if (args.Length < 3)
                    {
                        PrintError("Missing arguments for sign-data: <alias> <dataBase64>");
                        return 1;
                    }
                    return HandleSignData(args[1], args[2]);
                }
                else if (command == "verify-data")
                {
                    if (args.Length < 4)
                    {
                        PrintError("Missing arguments for verify-data: <certBase64> <dataBase64> <sigBase64>");
                        return 1;
                    }
                    return HandleVerifyData(args[1], args[2], args[3]);
                }
                else if (command == "session")
                {
                    if (args.Length < 2)
                    {
                        PrintError("Missing arguments for session: <alias>");
                        return 1;
                    }
                    return HandleSession(args[1]);
                }
                else
                {
                    PrintError("Unknown command: " + command);
                    return 1;
                }
            }
            catch (Exception ex)
            {
                PrintError(ex.Message != null ? ex.Message : ex.ToString());
                return 1;
            }
        }

        static int HandleListCerts()
        {
            List<string> certList = new List<string>();
            HashSet<string> seenThumbprints = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            DateTime now = DateTime.UtcNow;

            StoreLocation[] locations = new StoreLocation[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine };
            foreach (StoreLocation loc in locations)
            {
                try
                {
                    using (X509Store store = new X509Store(StoreName.My, loc))
                    {
                        store.Open(OpenFlags.ReadOnly);

                        foreach (X509Certificate2 cert in store.Certificates)
                        {
                            try
                            {
                                string thumbprint = cert.Thumbprint != null ? cert.Thumbprint.ToUpperInvariant() : "";
                                if (string.IsNullOrEmpty(thumbprint) || seenThumbprints.Contains(thumbprint)) continue;
                                seenThumbprints.Add(thumbprint);

                                bool hasPrivateKey = cert.HasPrivateKey;
                                string subject = cert.Subject != null ? cert.Subject : "";
                                string issuer = cert.Issuer != null ? cert.Issuer : "";

                                bool isSystemCert = issuer.IndexOf("MS-Organization-Access", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                    issuer.IndexOf("Microsoft Windows", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                    Regex.IsMatch(subject, "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");

                                bool canSign = false;
                                if (hasPrivateKey && !isSystemCert)
                                {
                                    bool hasKeyUsageExt = false;
                                    foreach (X509Extension ext in cert.Extensions)
                                    {
                                        X509KeyUsageExtension ku = ext as X509KeyUsageExtension;
                                        if (ku != null)
                                        {
                                            hasKeyUsageExt = true;
                                            canSign = (ku.KeyUsages & (X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.NonRepudiation)) != 0;
                                            break;
                                        }
                                    }
                                    if (!hasKeyUsageExt)
                                    {
                                        canSign = true;
                                    }
                                }

                                bool isExpired = cert.NotAfter.ToUniversalTime() < now;
                                bool notYetValid = cert.NotBefore.ToUniversalTime() > now;
                                bool isEligible = !isSystemCert && hasPrivateKey && canSign && !isExpired && !notYetValid;

                                string keyAlgorithm = "RSA";
                                int keySize = 0;
                                try
                                {
                                    if (cert.PublicKey != null)
                                    {
                                        if (cert.PublicKey.Oid != null && !string.IsNullOrEmpty(cert.PublicKey.Oid.FriendlyName))
                                        {
                                            keyAlgorithm = cert.PublicKey.Oid.FriendlyName;
                                        }
                                        if (cert.PublicKey.Key != null)
                                        {
                                            keySize = cert.PublicKey.Key.KeySize;
                                        }
                                    }
                                }
                                catch { }

                                string serialNumber = cert.SerialNumber != null ? cert.SerialNumber.ToUpperInvariant() : "";
                                string certDerBase64 = Convert.ToBase64String(cert.RawData);

                                string validFrom = cert.NotBefore.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");
                                string validTo = cert.NotAfter.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

                                StringBuilder sbItem = new StringBuilder();
                                sbItem.Append("{");
                                sbItem.Append("\"alias\":\"").Append(EscapeJson(thumbprint)).Append("\",");
                                sbItem.Append("\"subject\":\"").Append(EscapeJson(subject)).Append("\",");
                                sbItem.Append("\"issuer\":\"").Append(EscapeJson(issuer)).Append("\",");
                                sbItem.Append("\"serialNumber\":\"").Append(EscapeJson(serialNumber)).Append("\",");
                                sbItem.Append("\"validFrom\":\"").Append(validFrom).Append("\",");
                                sbItem.Append("\"validTo\":\"").Append(validTo).Append("\",");
                                sbItem.Append("\"hasPrivateKey\":").Append(hasPrivateKey ? "true" : "false").Append(",");
                                sbItem.Append("\"isExpired\":").Append(isExpired ? "true" : "false").Append(",");
                                sbItem.Append("\"notYetValid\":").Append(notYetValid ? "true" : "false").Append(",");
                                sbItem.Append("\"isSystemCert\":").Append(isSystemCert ? "true" : "false").Append(",");
                                sbItem.Append("\"isEligibleForSigning\":").Append(isEligible ? "true" : "false").Append(",");
                                sbItem.Append("\"keyAlgorithm\":\"").Append(EscapeJson(keyAlgorithm)).Append("\",");
                                sbItem.Append("\"keySize\":").Append(keySize).Append(",");
                                sbItem.Append("\"thumbprint\":\"").Append(thumbprint).Append("\",");
                                sbItem.Append("\"certDerBase64\":\"").Append(certDerBase64).Append("\"");
                                sbItem.Append("}");

                                certList.Add(sbItem.ToString());
                            }
                            catch
                            {
                                // Skip cert
                            }
                        }

                        store.Close();
                    }
                }
                catch { }
            }

            Console.WriteLine("{{\"success\":true,\"certificates\":[{0}]}}", string.Join(",", certList.ToArray()));
            return 0;
        }

        static bool MatchesAlias(X509Certificate2 cert, string cleanAlias)
        {
            if (cert == null || string.IsNullOrEmpty(cleanAlias)) return false;

            string thumb = cert.Thumbprint != null ? cert.Thumbprint.Trim().Replace(" ", "") : "";
            if (string.Equals(thumb, cleanAlias, StringComparison.OrdinalIgnoreCase)) return true;

            string serial = cert.SerialNumber != null ? cert.SerialNumber.Trim().Replace(" ", "") : "";
            if (string.Equals(serial, cleanAlias, StringComparison.OrdinalIgnoreCase)) return true;

            if (thumb.IndexOf(cleanAlias, StringComparison.OrdinalIgnoreCase) >= 0) return true;

            if (cert.Subject != null && cert.Subject.IndexOf(cleanAlias, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            if (cert.FriendlyName != null && cert.FriendlyName.IndexOf(cleanAlias, StringComparison.OrdinalIgnoreCase) >= 0) return true;

            return false;
        }

        static X509Certificate2 FindTargetCertificate(string rawAlias, out X509Store owningStore)
        {
            owningStore = null;
            if (string.IsNullOrEmpty(rawAlias)) return null;

            string cleanAlias = rawAlias.Trim().Trim('"', '\'').Replace(" ", "");

            // Retry up to 4 attempts (0ms, 400ms, 800ms, 1200ms) to allow Windows Smart Card
            // Certificate Propagation Service (CertPropSvc) to populate the store.
            for (int attempt = 0; attempt < 4; attempt++)
            {
                StoreLocation[] locations = new StoreLocation[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine };
                foreach (StoreLocation loc in locations)
                {
                    try
                    {
                        X509Store store = new X509Store(StoreName.My, loc);
                        store.Open(OpenFlags.ReadOnly);

                        foreach (X509Certificate2 cert in store.Certificates)
                        {
                            if (MatchesAlias(cert, cleanAlias))
                            {
                                owningStore = store;
                                return cert;
                            }
                        }
                        store.Close();
                    }
                    catch { }
                }

                if (attempt < 3)
                {
                    System.Threading.Thread.Sleep(400);
                }
            }

            return null;
        }

        static string GetAvailableCertificatesSummary()
        {
            List<string> list = new List<string>();
            StoreLocation[] locations = new StoreLocation[] { StoreLocation.CurrentUser, StoreLocation.LocalMachine };
            foreach (StoreLocation loc in locations)
            {
                try
                {
                    using (X509Store store = new X509Store(StoreName.My, loc))
                    {
                        store.Open(OpenFlags.ReadOnly);
                        foreach (X509Certificate2 c in store.Certificates)
                        {
                            list.Add(string.Format("{0} ({1})", c.Thumbprint, c.Subject));
                        }
                        store.Close();
                    }
                }
                catch { }
            }
            return string.Join("; ", list.ToArray());
        }

        static int HandleSignData(string alias, string dataBase64)
        {
            X509Store store = null;
            X509Certificate2 targetCert = FindTargetCertificate(alias, out store);

            if (targetCert == null)
            {
                string avail = GetAvailableCertificatesSummary();
                PrintError(string.Format("Certificate not found in Windows store: {0}. Available certificates: [{1}]. Please verify USB token is firmly plugged in.", alias, avail));
                return 1;
            }

            try
            {
                if (!targetCert.HasPrivateKey)
                {
                    PrintError("Certificate has no accessible private key: " + alias);
                    return 1;
                }

                byte[] data = Convert.FromBase64String(dataBase64);
                byte[] signatureBytes = null;

                // 1. Try .NET 4.6+ RSACertificateExtensions.GetRSAPrivateKey via reflection
                try
                {
                    Assembly coreAsm = typeof(Enumerable).Assembly; // System.Core.dll
                    Type extType = coreAsm.GetType("System.Security.Cryptography.X509Certificates.RSACertificateExtensions");
                    if (extType != null)
                    {
                        MethodInfo getRsaMethod = extType.GetMethod("GetRSAPrivateKey", new Type[] { typeof(X509Certificate2) });
                        if (getRsaMethod != null)
                        {
                            object rsaObj = getRsaMethod.Invoke(null, new object[] { targetCert });
                            if (rsaObj != null)
                            {
                                MethodInfo signDataMethod = rsaObj.GetType().GetMethod("SignData", new Type[] {
                                    typeof(byte[]),
                                    typeof(HashAlgorithmName),
                                    typeof(RSASignaturePadding)
                                });
                                if (signDataMethod != null)
                                {
                                    signatureBytes = (byte[])signDataMethod.Invoke(rsaObj, new object[] {
                                        data,
                                        HashAlgorithmName.SHA256,
                                        RSASignaturePadding.Pkcs1
                                    });
                                }
                            }
                        }
                    }
                }
                catch { }

                // 2. Try RSACryptoServiceProvider
                if (signatureBytes == null)
                {
                    try
                    {
                        RSACryptoServiceProvider rsaCsp = targetCert.PrivateKey as RSACryptoServiceProvider;
                        if (rsaCsp != null)
                        {
                            byte[] hash;
                            using (SHA256 sha = SHA256.Create())
                            {
                                hash = sha.ComputeHash(data);
                            }

                            try
                            {
                                signatureBytes = rsaCsp.SignHash(hash, CryptoConfig.MapNameToOID("SHA256"));
                            }
                            catch
                            {
                                // Handle older CSP providers by upgrading to PROV_RSA_AES (24)
                                CspParameters cspParams = new CspParameters(24, rsaCsp.CspKeyContainerInfo.ProviderName, rsaCsp.CspKeyContainerInfo.KeyContainerName);
                                if (rsaCsp.CspKeyContainerInfo.MachineKeyStore) cspParams.Flags |= CspProviderFlags.UseMachineKeyStore;
                                cspParams.Flags |= CspProviderFlags.UseExistingKey;
                                using (RSACryptoServiceProvider rsaAes = new RSACryptoServiceProvider(cspParams))
                                {
                                    signatureBytes = rsaAes.SignHash(hash, CryptoConfig.MapNameToOID("SHA256"));
                                }
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        if (store != null) { try { store.Close(); } catch { } }
                        PrintError("Signing failed via CSP: " + ex.Message);
                        return 1;
                    }
                }

                if (signatureBytes == null)
                {
                    if (store != null) { try { store.Close(); } catch { } }
                    PrintError("Unable to obtain RSA signing key from certificate");
                    return 1;
                }

                string sigBase64 = Convert.ToBase64String(signatureBytes);
                string certBase64 = Convert.ToBase64String(targetCert.RawData);

                Console.WriteLine("{{\"success\":true,\"signatureBase64\":\"{0}\",\"certBase64\":\"{1}\",\"algorithm\":\"SHA256withRSA\"}}",
                    sigBase64, certBase64);
                return 0;
            }
            catch (Exception ex)
            {
                PrintError(ex.Message != null ? ex.Message : ex.ToString());
                return 1;
            }
            finally
            {
                if (store != null) { try { store.Close(); } catch { } }
            }
        }

        static int HandleVerifyData(string certBase64, string dataBase64, string sigBase64)
        {
            byte[] certBytes = Convert.FromBase64String(certBase64);
            byte[] data = Convert.FromBase64String(dataBase64);
            byte[] sigBytes = Convert.FromBase64String(sigBase64);

            X509Certificate2 cert = new X509Certificate2(certBytes);
            bool valid = false;

            try
            {
                RSACryptoServiceProvider rsaCsp = cert.PublicKey.Key as RSACryptoServiceProvider;
                if (rsaCsp != null)
                {
                    using (SHA256 sha = SHA256.Create())
                    {
                        byte[] hash = sha.ComputeHash(data);
                        valid = rsaCsp.VerifyHash(hash, CryptoConfig.MapNameToOID("SHA256"), sigBytes);
                    }
                }
            }
            catch { }

            Console.WriteLine("{{\"success\":true,\"valid\":{0}}}", valid ? "true" : "false");
            return 0;
        }

        static int HandleSession(string alias)
        {
            X509Store store = null;
            X509Certificate2 targetCert = FindTargetCertificate(alias, out store);

            if (targetCert == null)
            {
                string avail = GetAvailableCertificatesSummary();
                PrintError(string.Format("Certificate not found in Windows store: {0}. Available certificates: [{1}]. Please verify USB token is firmly plugged in.", alias, avail));
                return 1;
            }

            try
            {
                if (!targetCert.HasPrivateKey)
                {
                    PrintError("Certificate has no accessible private key: " + alias);
                    if (store != null) { try { store.Close(); } catch { } }
                    return 1;
                }

                object rsaObj = null;
                MethodInfo signDataMethod = null;
                RSACryptoServiceProvider rsaCsp = null;

                // 1. Try .NET 4.6+ RSACertificateExtensions.GetRSAPrivateKey
                try
                {
                    Assembly coreAsm = typeof(Enumerable).Assembly;
                    Type extType = coreAsm.GetType("System.Security.Cryptography.X509Certificates.RSACertificateExtensions");
                    if (extType != null)
                    {
                        MethodInfo getRsaMethod = extType.GetMethod("GetRSAPrivateKey", new Type[] { typeof(X509Certificate2) });
                        if (getRsaMethod != null)
                        {
                            rsaObj = getRsaMethod.Invoke(null, new object[] { targetCert });
                            if (rsaObj != null)
                            {
                                signDataMethod = rsaObj.GetType().GetMethod("SignData", new Type[] {
                                    typeof(byte[]),
                                    typeof(HashAlgorithmName),
                                    typeof(RSASignaturePadding)
                                });
                            }
                        }
                    }
                }
                catch { }

                // 2. Try RSACryptoServiceProvider
                if (rsaObj == null || signDataMethod == null)
                {
                    try
                    {
                        RSACryptoServiceProvider origCsp = targetCert.PrivateKey as RSACryptoServiceProvider;
                        if (origCsp != null)
                        {
                            CspParameters cspParams = new CspParameters(24, origCsp.CspKeyContainerInfo.ProviderName, origCsp.CspKeyContainerInfo.KeyContainerName);
                            if (origCsp.CspKeyContainerInfo.MachineKeyStore) cspParams.Flags |= CspProviderFlags.UseMachineKeyStore;
                            cspParams.Flags |= CspProviderFlags.UseExistingKey;
                            rsaCsp = new RSACryptoServiceProvider(cspParams);
                        }
                    }
                    catch
                    {
                        rsaCsp = targetCert.PrivateKey as RSACryptoServiceProvider;
                    }
                }

                if (rsaObj == null && rsaCsp == null)
                {
                    PrintError("Unable to obtain RSA signing key from certificate");
                    store.Close();
                    return 1;
                }

                string thumbprint = targetCert.Thumbprint != null ? targetCert.Thumbprint.ToUpperInvariant() : "";
                string certBase64 = Convert.ToBase64String(targetCert.RawData);

                // Output ready notification with certificate details
                Console.WriteLine("{{\"success\":true,\"sessionReady\":true,\"thumbprint\":\"{0}\",\"certBase64\":\"{1}\"}}",
                    EscapeJson(thumbprint), certBase64);

                // Command processing loop
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    line = line.Trim();
                    if (string.IsNullOrEmpty(line)) continue;

                    string cmd = "";
                    string dataBase64 = "";

                    if (line.StartsWith("{"))
                    {
                        cmd = ExtractJsonValue(line, "cmd");
                        dataBase64 = ExtractJsonValue(line, "dataBase64");
                    }
                    else if (line.StartsWith("sign "))
                    {
                        cmd = "sign";
                        dataBase64 = line.Substring(5).Trim();
                    }
                    else if (line == "close" || line == "exit" || line == "quit")
                    {
                        cmd = "close";
                    }

                    if (cmd == "close")
                    {
                        break;
                    }
                    else if (cmd == "ping")
                    {
                        Console.WriteLine("{\"success\":true,\"pong\":true}");
                    }
                    else if (cmd == "sign")
                    {
                        if (string.IsNullOrEmpty(dataBase64))
                        {
                            PrintError("Missing dataBase64 for sign command");
                            continue;
                        }

                        try
                        {
                            byte[] data = Convert.FromBase64String(dataBase64);
                            byte[] signatureBytes = null;

                            if (rsaObj != null && signDataMethod != null)
                            {
                                signatureBytes = (byte[])signDataMethod.Invoke(rsaObj, new object[] {
                                    data,
                                    HashAlgorithmName.SHA256,
                                    RSASignaturePadding.Pkcs1
                                });
                            }
                            else if (rsaCsp != null)
                            {
                                byte[] hash;
                                using (SHA256 sha = SHA256.Create())
                                {
                                    hash = sha.ComputeHash(data);
                                }
                                signatureBytes = rsaCsp.SignHash(hash, CryptoConfig.MapNameToOID("SHA256"));
                            }

                            if (signatureBytes != null)
                            {
                                string sigBase64 = Convert.ToBase64String(signatureBytes);
                                Console.WriteLine("{{\"success\":true,\"signatureBase64\":\"{0}\",\"certBase64\":\"{1}\",\"algorithm\":\"SHA256withRSA\"}}",
                                    sigBase64, certBase64);
                            }
                            else
                            {
                                PrintError("Signing failed: no signature produced");
                            }
                        }
                        catch (Exception ex)
                        {
                            string err = ex.InnerException != null ? ex.InnerException.Message : ex.Message;
                            PrintError(err);
                        }
                    }
                    else
                    {
                        PrintError("Unknown session command: " + line);
                    }
                }

                if (rsaCsp != null)
                {
                    try { ((IDisposable)rsaCsp).Dispose(); } catch { }
                }

                Console.WriteLine("{\"success\":true,\"closed\":true}");
                return 0;
            }
            catch (Exception ex)
            {
                PrintError(ex.Message);
                return 1;
            }
            finally
            {
                if (store != null) { try { store.Close(); } catch { } }
            }
        }

        static string ExtractJsonValue(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            string pattern = "\"" + key + "\"[\\s]*:[\\s]*\"([^\"]*)\"";
            Match m = Regex.Match(json, pattern);
            if (m.Success) return m.Groups[1].Value;
            return null;
        }

        static void PrintError(string message)
        {
            Console.WriteLine("{{\"success\":false,\"error\":\"{0}\"}}", EscapeJson(message));
        }

        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
        }
    }
}
