# Inicializa la base de datos (tablas, sucursales, ubicaciones) y crea el primer administrador.
# Uso:  .\scripts\inicializar.ps1 -Url https://SU-DOMINIO.vercel.app
# Las claves se piden por consola y no se guardan ni se muestran.
param([Parameter(Mandatory = $true)][string]$Url)

function LeerSecreto($mensaje) {
    $s = Read-Host $mensaje -AsSecureString
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
}

$token = LeerSecreto 'SETUP_TOKEN (el que guardó en Vercel)'
$usuario = Read-Host 'Usuario del administrador (ej. admin)'
$nombre = Read-Host 'Nombre completo del administrador'
$clave = LeerSecreto 'Contraseña del administrador (mínimo 8 caracteres)'
$clave2 = LeerSecreto 'Repita la contraseña'
if ($clave -ne $clave2) { Write-Host 'Las contraseñas no coinciden.' -ForegroundColor Red; exit 1 }

$body = @{ usuario = $usuario; nombre = $nombre; password = $clave } | ConvertTo-Json
try {
    $r = Invoke-RestMethod -Method Post -Uri ($Url.TrimEnd('/') + '/api/setup') `
        -Headers @{ 'x-setup-token' = $token } -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
    Write-Host ("Listo. Sucursales: {0}, ubicaciones: {1}, administrador creado: {2}" -f $r.sucursales, $r.ubicaciones, $r.adminCreado) -ForegroundColor Green
} catch {
    $detalle = if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $_.Exception.Message }
    Write-Host "Error: $detalle" -ForegroundColor Red
    exit 1
}
