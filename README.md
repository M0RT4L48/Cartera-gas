# Gas_App Financiero · Control de Cartera CxC y Débito Prepago

Aplicación web basada en `Gas_App.xlsx` y en el diseño de `gas_app_financiero.html`.
**Sin dependencias externas** (no requiere `npm install` ni internet): Node.js 22.13+ con SQLite integrado.

## Arranque (Windows / PowerShell)

```powershell
cd cartera-gas
node --disable-warning=ExperimentalWarning server/index.js      # o doble clic en iniciar.bat
```

Abre <http://localhost:3000>. En el **primer arranque** la consola muestra el usuario `admin` y una **contraseña temporal**
(se te obliga a cambiarla al entrar). La base ya trae cargada la información de `Gas_App.xlsx` (corte 13/10/2026).

Variables opcionales: `PORT` (3000), `HOST` (127.0.0.1; `0.0.0.0` para red local), `COOKIE_SECURE=1` (con HTTPS),
`SESION_HORAS` (10), `ADMIN_PASSWORD` (solo primer arranque), `DB_PATH`, `PYTHON` (ejecutable para la carga de Excel).

## Ejecutar con Docker

Requiere Docker Desktop con Docker Compose. Desde esta carpeta, inicia la aplicación con:

```powershell
docker volume create cartera-gas-data
docker compose up --build -d
docker compose logs -f cartera-gas
```

Abre <http://localhost:3000>. Para acceder desde otras computadoras de la red local, usa la dirección IP del equipo que ejecuta Docker, por ejemplo `http://192.168.1.20:3000`, y permite el puerto 3000 en el firewall de ese equipo.

La base SQLite vive en el volumen Docker `cartera-gas-data`, dentro del disco Linux de Docker Desktop, para evitar la penalización de I/O de SQLite sobre carpetas de Windows. El volumen sobrevive al actualizar o recrear el contenedor y no se copia dentro de la imagen. Los respaldos y archivos temporales de importación siguen en `respaldos` y `tmp` dentro de esta carpeta.

Si ya tenías la aplicación ejecutándose con una carpeta `data` enlazada desde Windows, detén el contenedor y copia sus archivos al volumen antes de volver a iniciarlo. Desde PowerShell, en la carpeta `cartera-gas`, ejecuta:

```powershell
docker compose stop
docker volume create cartera-gas-data
docker run --rm --user root -v cartera-gas-data:/target -v "${PWD}\data:/source:ro" cartera-gas-cartera-gas sh -c "cp -a /source/. /target/ && chown -R node:node /target"
docker compose up -d
```

La carpeta `data` original se conserva como copia, pero Compose ya no la usa. Para respaldar la base del volumen, detén primero la aplicación y copia el volumen con un contenedor auxiliar a una ubicación segura.

Comandos útiles:

```powershell
docker compose stop
docker compose up --build -d
docker compose down
```

`docker compose down` elimina el contenedor, pero no el volumen `cartera-gas-data` ni las carpetas de respaldos y temporales del host. No uses `docker compose down -v` salvo que realmente quieras eliminar el volumen de la base de datos. No compartas una base SQLite por una unidad de red como sustituto del acceso web.

## Pestañas (igual que el diseño de referencia)

| Pestaña | Qué hace |
|---|---|
| **Cartera Activa** | Antigüedad, facturado vs cobrado y listado de facturas; permite registrar facturas para clientes del catálogo y calcula el vencimiento según sus días de crédito |
| **Aplicación de Pagos (CxC)** | Elige cliente, captura el monto total y guarda el cobro sin aplicar o distribuye **FIFO** (facturas más antiguas primero) o manualmente; solicita banco para transferencias y cheques, conserva el banco en el historial y el sobrante como monto no aplicado |
| **Por Facturar** | Registra importes pendientes por cliente y muestra sus despachos; al emitir una factura se seleccionan los despachos que se transferirán a CxC |
| **Control de Débito** | Registra abonos (+) con método de pago y banco, y consumos (−) de saldo prepagado; consulta saldos a favor e historial filtrable por cliente, operación y fechas, con paginación; permite anular movimientos capturados en la app |
| **Cobranza / Alertas** | Gestiones y promesas de pago; alertas de límite excedido, >60 días, próximas a vencer, sin límite, sin vencimiento |
| **Clientes** | Catálogo de clientes: alta, edición, crédito, contacto, saldos, filtros y exportación CSV; ficha individual con estado de cuenta CSV filtrable por fechas |
| **Catálogos** | Administración de bancos y métodos de pago por el administrador general |
| **Usuarios y Roles** | Alta/edición de usuarios, rol y estación asignada; bitácora |
| **Carga de Datos** | Sube `Gas_App.xlsx` desde el navegador (respaldo automático previo) |

Las 4 tarjetas superiores (facturas abiertas, saldo abierto, saldo vencido, saldo a favor) respetan la estación y la fecha de corte elegidas.

## Modelo de datos (estrella)

| Tabla | Origen | Contenido |
|---|---|---|
| `dim_cliente` | `Dim_Clientes` | Catálogo maestro (llave `K_Cliente` = estación + cliente) |
| `dim_estacion` | columna `ESTACION` | Catálogo de gasolineras |
| `dim_tiempo` | generada 2018-2028 | Año, trimestre, mes, semana, día |
| `fact_debito` | `Debito` | Recargas (`ABONO`) y consumos (`IMPORTE`) |
| `fact_cxc` | `CxC` | Un renglón por despacho |
| `fact_factura` | derivada de `CxC` | Agregado de origen por factura |
| `credito` | `Credito` | Límite financiero y días de crédito |

Tablas de la aplicación: `usuarios`, `sesiones`, `pagos`, `debito_app`, `fact_cxc_app`, `cliente_extra`, `gestiones`, `bitacora`, `bancos` y `metodos_pago`. Las cargas parciales las conservan; la carga completa las reinicia y vuelve a crear los catálogos base y el administrador inicial. Las vistas `v_cxc` y `v_fact_factura` unifican los saldos del Excel y las facturas capturadas en la aplicación.

## Reglas de cálculo

- **Saldo de factura** = Importe − Abono (Excel) − pagos capturados en la app. Solo facturas con estatus `POR PAGAR` o `ABONADO`.
- **Por facturar**: despachos `POR FACTURAR`. Se pueden registrar importes para un cliente y seleccionar uno o varios despachos para emitir una factura; solo los seleccionados pasan a CxC. **Cartera total** = facturada pendiente + por facturar.
- **Vencimiento** = fecha de factura + días de crédito actuales del cliente; al editar los días de crédito, la fecha de vencimiento y los días vencidos se recalculan en cartera. **Días vencido** = fecha de corte − vencimiento. Rangos: No vencido, 1-15, 16-30, 31-60, 61-90, 91-120, más de 120.
- **Riesgo**: `EXCEDIDO` (saldo total > límite), `SIN LÍMITE` (saldo con límite 0), `OK`.
- **Saldo de débito** = abonos − consumos. Un consumo mayor al saldo se permite con aviso (queda negativo), como en el diseño original.
- El catálogo de bancos inicia con BBVA, Santander y Banco Azteca. Se exige elegir banco para Transferencia SPEI y Cheque; el banco queda guardado en cada pago para conservar el dato histórico aunque el catálogo cambie.
- El catálogo de métodos de pago inicia con Transferencia SPEI, Efectivo, Cheque, Tarjeta, Compensación y Otro. Sus opciones se administran en **Catálogos** y se comparten entre Aplicación de Pagos y Control de Débito; se puede configurar qué métodos requieren banco en pagos CxC. Los movimientos guardan el nombre del método para conservar el historial aunque se elimine del catálogo.
- Los abonos en **Control de Débito** requieren método de pago y banco del catálogo; ambos datos se conservan en el historial. Los consumos no requieren ninguno de los dos.
- Los clientes pueden cambiar de estación; se trasladan los registros vinculados y la edición se conserva al reimportar datos.
- En **Cartera Activa**, usuarios administradores y gestores pueden registrar y editar facturas capturadas en la app para clientes existentes. El vencimiento se calcula sumando los días de crédito del cliente a la fecha de factura; da de alta clientes primero en **Clientes**. No se editan renglones importados del Excel, y no se puede bajar el importe por debajo de lo ya abonado ni cambiar el folio si tiene pagos registrados.
- No se usa `SALDO ACUMULADO POR CLIENTE` (acumulado dependiente del contexto, no sumable).

## Usuarios y roles

| Rol | Permisos |
|---|---|
| Administrador General | Todo: usuarios, bitácora y carga de Excel incluidos |
| Gestor de Estación | Consultar/exportar, débito, pagos, facturas, gestiones, altas de clientes y edición de crédito en su estación |
| Consulta | Solo lectura y exportación |

Cada usuario puede tener **una o varias estaciones asignadas** (se valida en el servidor). Contraseñas con scrypt, cambio obligatorio
en el primer acceso, bloqueo de 15 min tras 5 intentos fallidos, cookie HttpOnly/SameSite y bitácora de acciones.

## Actualizar datos

Desde **Carga de Datos** puedes elegir:

- **Carga completa** (predeterminada): reemplaza todo el modelo y elimina los datos operativos y administrativos de la aplicación, incluidos usuarios, sesiones, bancos y métodos personalizados, pagos, movimientos manuales, facturas capturadas, clientes creados/ajustados y gestiones. Después crea nuevamente el usuario `admin`; si no se configuró `ADMIN_PASSWORD`, la aplicación muestra una contraseña temporal de un solo uso y obliga a cambiarla. La sesión actual se cierra.
- **Carga parcial**: reemplaza únicamente los módulos elegidos: **Clientes y crédito** (`Dim_Clientes` + `Credito`), **CxC / Cartera** o **Débito prepago**. Se conserva el resto de datos, incluidos los registros manuales. Al reemplazar CxC, los pagos manuales se marcan conciliados; al reemplazar Débito, se concilian los movimientos manuales. Se utiliza un libro Excel completo con las cuatro hojas requeridas.

Ambas modalidades generan un respaldo antes de importar y ejecutan la escritura en una transacción; si ocurre un error, se revierte la carga.

La importación por línea de comandos requiere Python con `pandas` y `openpyxl`:

```powershell
node --disable-warning=ExperimentalWarning server/respaldo.js
python etl/importar_excel.py "C:\ruta\Gas_App.xlsx" --mode full
python etl/importar_excel.py "C:\ruta\Gas_App.xlsx" --mode partial --modules cxc,debito
```

## Producción

1. Servidor con Node 22.13+. Inicia con `HOST=0.0.0.0` detrás de un proxy HTTPS (IIS/ARR, Nginx, Caddy) y `COOKIE_SECURE=1`.
2. Mantén el proceso con un servicio (NSSM en Windows, systemd o pm2 en Linux).
3. Programa `node server/respaldo.js` a diario (conserva los 30 más recientes en `respaldos/`).
4. Un usuario por persona; desactiva (no borres) a quien salga para conservar la bitácora.

## Pruebas

```powershell
node --disable-warning=ExperimentalWarning server/prueba.js
```
32 pruebas de integración sobre una copia temporal de la base: cifras del modelo, filtros, pagos individuales y FIFO, débito, altas de cliente,
permisos, alcance por estación, bloqueo de cuenta y seguridad de exportación CSV. La prueba de importación real del Excel se ejecuta solo si se define
`XLSX_PRUEBA` con la ruta a un archivo válido; no se incluye un Excel de prueba en el repositorio.
