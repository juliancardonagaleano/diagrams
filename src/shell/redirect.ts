/** `suite.html` ya no es una ruta: el inicio es la suite. Se quita `embed` para que esta página no se vuelva el editor embebible. */
const url = new URL(window.location.href);
url.pathname = url.pathname.replace(/suite\.html$/, '');
if (url.pathname === '') url.pathname = '/';
url.searchParams.delete('embed');
window.location.replace(`${url.pathname}${url.search}${url.hash}`);
