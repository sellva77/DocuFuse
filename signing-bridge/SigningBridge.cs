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
            DateTime now = DateTime.UtcNow;

            using (X509Store store = new X509Store(StoreName.My, StoreLocation.CurrentUser))
            {
                store.Open(OpenFlags.ReadOnly);

                foreach (X509Certificate2 cert in store.Certificates)
                {
                    try
                    {
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

                        string thumbprint = cert.Thumbprint != null ? cert.Thumbprint.ToUpperInvariant() : "";
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

            Console.WriteLine("{{\"success\":true,\"certificates\":[{0}]}}", string.Join(",", certList.ToArray()));
            return 0;
        }

        static int HandleSignData(string alias, string dataBase64)
        {
            X509Certificate2 targetCert = null;

            using (X509Store store = new X509Store(StoreName.My, StoreLocation.CurrentUser))
            {
                store.Open(OpenFlags.ReadOnly);

                foreach (X509Certificate2 cert in store.Certificates)
                {
                    if (string.Equals(cert.Thumbprint, alias, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(cert.SerialNumber, alias, StringComparison.OrdinalIgnoreCase) ||
                        string.Equals(cert.FriendlyName, alias, StringComparison.OrdinalIgnoreCase))
                    {
                        targetCert = cert;
                        break;
                    }
                }

                if (targetCert == null)
                {
                    foreach (X509Certificate2 cert in store.Certificates)
                    {
                        if ((cert.Thumbprint != null && cert.Thumbprint.IndexOf(alias, StringComparison.OrdinalIgnoreCase) >= 0) ||
                            (cert.Subject != null && cert.Subject.IndexOf(alias, StringComparison.OrdinalIgnoreCase) >= 0))
                        {
                            targetCert = cert;
                            break;
                        }
                    }
                }

                if (targetCert == null)
                {
                    store.Close();
                    PrintError("Certificate not found in Windows-MY store: " + alias);
                    return 1;
                }

                if (!targetCert.HasPrivateKey)
                {
                    store.Close();
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
                        store.Close();
                        PrintError("Signing failed via CSP: " + ex.Message);
                        return 1;
                    }
                }

                if (signatureBytes == null)
                {
                    store.Close();
                    PrintError("Unable to obtain RSA signing key from certificate");
                    return 1;
                }

                string sigBase64 = Convert.ToBase64String(signatureBytes);
                string certBase64 = Convert.ToBase64String(targetCert.RawData);

                store.Close();

                Console.WriteLine("{{\"success\":true,\"signatureBase64\":\"{0}\",\"certBase64\":\"{1}\",\"algorithm\":\"SHA256withRSA\"}}",
                    sigBase64, certBase64);
                return 0;
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
