// Cliente de la API. La sesión viaja en una cookie HttpOnly, el código no maneja tokens.
class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
        res = await fetch(path, {
            method,
            credentials: 'same-origin',
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
            body: body !== undefined ? JSON.stringify(body) : undefined
        });
    } catch (e) {
        throw new ApiError('Sin conexión con el servidor. Revise su internet e intente de nuevo.', 0);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* respuesta sin cuerpo */ }
    if (!res.ok) {
        // Sesión vencida en medio del conteo: se vuelve al login (lo escrito en pantalla no se guardó)
        if (res.status === 401 && typeof onSessionExpired === 'function' && !path.includes('action=login') && !path.includes('action=me')) {
            onSessionExpired();
        }
        throw new ApiError((data && data.error) || `Error del servidor (${res.status})`, res.status);
    }
    return data;
}
