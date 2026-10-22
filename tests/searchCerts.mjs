import { execSync } from 'child_process';

try {
  const psCmd = `Get-ChildItem -Path Cert:\\ -Recurse | Where-Object { $_.Subject -like '*BALAJI*' -or $_.FriendlyName -like '*BALAJI*' } | Select-Object -Property Thumbprint, Subject, Issuer, PSParentPath | ConvertTo-Json`;
  const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' });
  console.log('Result:', out);
} catch (e) {
  console.error('Error:', e.message);
}
