param(
    [string]$Command,
    [string]$Arg1,
    [string]$Arg2,
    [string]$Arg3
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Escape-Json([string]$str) {
    if (-not $str) { return "" }
    return $str.Replace('\', '\\').Replace('"', '\"').Replace("`r", "").Replace("`n", "\n")
}

function Get-IsoDate($date) {
    if (-not $date) { return "" }
    return $date.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
}

function Find-TargetCertificate([string]$rawAlias) {
    if (-not $rawAlias) { return $null }
    $clean = $rawAlias.Trim().Trim('"').Trim("'").Replace(" ", "")

    for ($i = 0; $i -lt 4; $i++) {
        foreach ($loc in @("CurrentUser", "LocalMachine")) {
            try {
                $st = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", $loc)
                $st.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
                foreach ($c in $st.Certificates) {
                    $thumb = if ($c.Thumbprint) { $c.Thumbprint.Trim().Replace(" ", "") } else { "" }
                    $serial = if ($c.SerialNumber) { $c.SerialNumber.Trim().Replace(" ", "") } else { "" }
                    if ($thumb -ieq $clean -or $serial -ieq $clean -or $thumb -like "*$clean*" -or ($c.Subject -and $c.Subject -like "*$clean*") -or ($c.FriendlyName -and $c.FriendlyName -like "*$clean*")) {
                        return @{ Cert = $c; Store = $st }
                    }
                }
                $st.Close()
            } catch {}
        }
        if ($i -lt 3) { Start-Sleep -Milliseconds 400 }
    }
    return $null
}

if ($Command -eq "list-certs") {
    $certsList = @()
    $seen = @{}
    $now = [DateTime]::UtcNow

    foreach ($loc in @("CurrentUser", "LocalMachine")) {
        try {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", $loc)
            $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)

            foreach ($cert in $store.Certificates) {
                try {
                    $thumbprint = if ($cert.Thumbprint) { $cert.Thumbprint.ToUpper() } else { "" }
                    if (-not $thumbprint -or $seen.ContainsKey($thumbprint)) { continue }
                    $seen[$thumbprint] = $true

                    $hasKey = $cert.HasPrivateKey
                    $subject = if ($cert.Subject) { $cert.Subject } else { "" }
                    $issuer = if ($cert.Issuer) { $cert.Issuer } else { "" }
                    $isSystem = ($issuer -like "*MS-Organization-Access*" -or $issuer -like "*Microsoft Windows*" -or $subject -match "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
                    
                    $canSign = $false
                    if ($hasKey -and -not $isSystem) {
                        $canSign = $true
                        foreach ($ext in $cert.Extensions) {
                            if ($ext -is [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]) {
                                $usages = $ext.KeyUsages
                                $canSign = [bool]($usages -band ([System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::NonRepudiation))
                                break
                            }
                        }
                    }

                    $isExpired = ($cert.NotAfter.ToUniversalTime() -lt $now)
                    $notYetValid = ($cert.NotBefore.ToUniversalTime() -gt $now)
                    $isEligible = (-not $isSystem -and $hasKey -and $canSign -and -not $isExpired -and -not $notYetValid)

                    $keyAlg = "RSA"
                    $keySize = 0
                    try {
                        if ($cert.PublicKey -and $cert.PublicKey.Key) {
                            $keySize = $cert.PublicKey.Key.KeySize
                            $keyAlg = $cert.PublicKey.Oid.FriendlyName
                        }
                    } catch {}

                    $certDerBase64 = [Convert]::ToBase64String($cert.RawData)

                    $item = "{" +
                        "`"alias`":`"$thumbprint`"," +
                        "`"subject`":`"$(Escape-Json $subject)`"," +
                        "`"issuer`":`"$(Escape-Json $issuer)`"," +
                        "`"serialNumber`":`"$($cert.SerialNumber.ToUpper())`"," +
                        "`"validFrom`":`"$(Get-IsoDate $cert.NotBefore)`"," +
                        "`"validTo`":`"$(Get-IsoDate $cert.NotAfter)`"," +
                        "`"hasPrivateKey`":$([bool]$hasKey).ToString().ToLower()," +
                        "`"isExpired`":$([bool]$isExpired).ToString().ToLower()," +
                        "`"notYetValid`":$([bool]$notYetValid).ToString().ToLower()," +
                        "`"isSystemCert`":$([bool]$isSystem).ToString().ToLower()," +
                        "`"isEligibleForSigning`":$([bool]$isEligible).ToString().ToLower()," +
                        "`"keyAlgorithm`":`"$(Escape-Json $keyAlg)`"," +
                        "`"keySize`":$keySize," +
                        "`"thumbprint`":`"$thumbprint`"," +
                        "`"certDerBase64`":`"$certDerBase64`"" +
                        "}"
                    $certsList += $item
                } catch {}
            }
            $store.Close()
        } catch {}
    }

    Write-Output ("{`"success`":true,`"certificates`":[" + ($certsList -join ",") + "]}")
    exit 0
}
elseif ($Command -eq "sign-data") {
    $alias = $Arg1
    $dataBase64 = $Arg2

    if (-not $alias -or -not $dataBase64) {
        Write-Output '{"success":false,"error":"Missing alias or dataBase64"}'
        exit 1
    }

    $found = Find-TargetCertificate $alias
    if (-not $found) {
        Write-Output ("{`"success`":false,`"error`":`"Certificate not found in Windows store: $(Escape-Json $alias). Please verify USB token is plugged in.`"}")
        exit 1
    }

    $targetCert = $found.Cert
    $store = $found.Store

    if (-not $targetCert.HasPrivateKey) {
        if ($store) { $store.Close() }
        Write-Output ("{`"success`":false,`"error`":`"Certificate has no accessible private key: $(Escape-Json $alias)`"}")
        exit 1
    }

    $dataBytes = [Convert]::FromBase64String($dataBase64)
    $sigBytes = $null

    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($targetCert)
        if ($rsa) {
            $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
            $hashAlg = [System.Security.Cryptography.HashAlgorithmName]::SHA256
            $sigBytes = $rsa.SignData($dataBytes, $hashAlg, $padding)
        }
    } catch {}

    if (-not $sigBytes) {
        try {
            $rsaCsp = [System.Security.Cryptography.RSACryptoServiceProvider]$targetCert.PrivateKey
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            $hash = $sha256.ComputeHash($dataBytes)
            $oid = [System.Security.Cryptography.CryptoConfig]::MapNameToOID("SHA256")
            $sigBytes = $rsaCsp.SignHash($hash, $oid)
        } catch {
            $store.Close()
            $err = Escape-Json $_.Exception.Message
            Write-Output "{`"success`":false,`"error`":`"Signing error: $err`"}"
            exit 1
        }
    }

    $store.Close()

    if (-not $sigBytes) {
        Write-Output '{"success":false,"error":"Unable to obtain RSA signing key from certificate"}'
        exit 1
    }

    $sigBase64 = [Convert]::ToBase64String($sigBytes)
    $certBase64 = [Convert]::ToBase64String($targetCert.RawData)

    Write-Output "{`"success`":true,`"signatureBase64`":`"$sigBase64`",`"certBase64`":`"$certBase64`",`"algorithm`":`"SHA256withRSA`"}"
    exit 0
}
elseif ($Command -eq "verify-data") {
    $certBase64 = $Arg1
    $dataBase64 = $Arg2
    $sigBase64 = $Arg3

    $certBytes = [Convert]::FromBase64String($certBase64)
    $dataBytes = [Convert]::FromBase64String($dataBase64)
    $sigBytes = [Convert]::FromBase64String($sigBase64)

    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(,$certBytes)
    $valid = $false

    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($cert)
        if ($rsa) {
            $valid = $rsa.VerifyData($dataBytes, $sigBytes, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
        }
    } catch {}

    if (-not $valid) {
        try {
            $rsaCsp = [System.Security.Cryptography.RSACryptoServiceProvider]$cert.PublicKey.Key
            $sha256 = [System.Security.Cryptography.SHA256]::Create()
            $hash = $sha256.ComputeHash($dataBytes)
            $oid = [System.Security.Cryptography.CryptoConfig]::MapNameToOID("SHA256")
            $valid = $rsaCsp.VerifyHash($hash, $oid, $sigBytes)
        } catch {}
    }

    Write-Output "{`"success`":true,`"valid`":$([bool]$valid).ToString().ToLower()}"
    exit 0
}
elseif ($Command -eq "session") {
    $alias = $Arg1
    if (-not $alias) {
        Write-Output '{"success":false,"error":"Missing alias for session"}'
        exit 1
    }

    $found = Find-TargetCertificate $alias
    if (-not $found) {
        Write-Output ("{`"success`":false,`"error`":`"Certificate not found: $(Escape-Json $alias). Please verify USB token is plugged in.`"}")
        exit 1
    }

    $targetCert = $found.Cert
    $store = $found.Store

    if (-not $targetCert.HasPrivateKey) {
        if ($store) { $store.Close() }
        Write-Output ("{`"success`":false,`"error`":`"Certificate has no private key: $(Escape-Json $alias)`"}")
        exit 1
    }

    $rsa = $null
    try {
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($targetCert)
    } catch {}

    $rsaCsp = $null
    if (-not $rsa) {
        try {
            $rsaCsp = [System.Security.Cryptography.RSACryptoServiceProvider]$targetCert.PrivateKey
        } catch {}
    }

    $thumbprint = $targetCert.Thumbprint.ToUpper()
    $certBase64 = [Convert]::ToBase64String($targetCert.RawData)

    Write-Output "{`"success`":true,`"sessionReady`":true,`"thumbprint`":`"$thumbprint`",`"certBase64`":`"$certBase64`"}"

    while ($true) {
        $line = [Console]::ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if (-not $line) { continue }

        if ($line -eq "close" -or $line -like "*`"close`"*") {
            break
        }
        elseif ($line -eq "ping" -or $line -like "*`"ping`"*") {
            Write-Output '{"success":true,"pong":true}'
            continue
        }

        $dataBase64 = ""
        if ($line.StartsWith("{")) {
            if ($line -match '"dataBase64"\s*:\s*"([^"]+)"') {
                $dataBase64 = $matches[1]
            }
        } elseif ($line.StartsWith("sign ")) {
            $dataBase64 = $line.Substring(5).Trim()
        }

        if (-not $dataBase64) {
            Write-Output '{"success":false,"error":"Missing dataBase64"}'
            continue
        }

        try {
            $dataBytes = [Convert]::FromBase64String($dataBase64)
            $sigBytes = $null

            if ($rsa) {
                $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
                $hashAlg = [System.Security.Cryptography.HashAlgorithmName]::SHA256
                $sigBytes = $rsa.SignData($dataBytes, $hashAlg, $padding)
            } elseif ($rsaCsp) {
                $sha256 = [System.Security.Cryptography.SHA256]::Create()
                $hash = $sha256.ComputeHash($dataBytes)
                $oid = [System.Security.Cryptography.CryptoConfig]::MapNameToOID("SHA256")
                $sigBytes = $rsaCsp.SignHash($hash, $oid)
            }

            if ($sigBytes) {
                $sigBase64 = [Convert]::ToBase64String($sigBytes)
                Write-Output "{`"success`":true,`"signatureBase64`":`"$sigBase64`",`"certBase64`":`"$certBase64`",`"algorithm`":`"SHA256withRSA`"}"
            } else {
                Write-Output '{"success":false,"error":"Signing returned null"}'
            }
        } catch {
            $err = Escape-Json $_.Exception.Message
            Write-Output "{`"success`":false,`"error`":`"$err`"}"
        }
    }

    $store.Close()
    Write-Output '{"success":true,"closed":true}'
    exit 0
}
else {
    Write-Output '{"success":false,"error":"Unknown command"}'
    exit 1
}
