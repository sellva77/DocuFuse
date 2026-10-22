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

if ($Command -eq "list-certs") {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "CurrentUser")
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    $certsList = @()
    $now = [DateTime]::UtcNow

    foreach ($cert in $store.Certificates) {
        try {
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
            $thumbprint = $cert.Thumbprint.ToUpper()

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

    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store("My", "CurrentUser")
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
    
    $targetCert = $null
    foreach ($cert in $store.Certificates) {
        if ($cert.Thumbprint -ieq $alias -or $cert.SerialNumber -ieq $alias -or $cert.FriendlyName -ieq $alias) {
            $targetCert = $cert
            break
        }
    }

    if (-not $targetCert) {
        foreach ($cert in $store.Certificates) {
            if ($cert.Thumbprint -like "*$alias*" -or $cert.Subject -like "*$alias*") {
                $targetCert = $cert
                break
            }
        }
    }

    if (-not $targetCert) {
        $store.Close()
        Write-Output ("{`"success`":false,`"error`":`"Certificate not found in Windows-MY store: $(Escape-Json $alias)`"}")
        exit 1
    }

    if (-not $targetCert.HasPrivateKey) {
        $store.Close()
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
else {
    Write-Output '{"success":false,"error":"Unknown command"}'
    exit 1
}
