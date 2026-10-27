#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Importa datos seleccionados de Gas_App.xlsx -> SQLite.

La carga completa reemplaza el modelo y reinicia los datos operativos de la app.
La carga parcial reemplaza solo los módulos elegidos y conserva los demás.
"""
import os, sqlite3, argparse, datetime as dt
import pandas as pd

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']
DIAS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']
HOJAS = ['Dim_Clientes', 'Credito', 'Debito', 'CxC']

def iso(s):
    d = pd.to_datetime(s, errors='coerce')
    return d.dt.strftime('%Y-%m-%d').where(d.notna(), None)

def txt(s):
    s = s.astype('object').where(s.notna(), None)
    return s.map(lambda v: None if v is None or str(v).strip() == '' else str(v).strip())

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('xlsx')
    ap.add_argument('--db', default=os.path.join(BASE, 'data', 'cartera.db'))
    ap.add_argument('--mode', choices=['full', 'partial'], default='full')
    ap.add_argument('--modules', default='clientes_credito,cxc,debito')
    a = ap.parse_args()
    full = a.mode == 'full'
    modules = {'clientes_credito', 'cxc', 'debito'} if full else set(filter(None, a.modules.split(',')))
    valid_modules = {'clientes_credito', 'cxc', 'debito'}
    invalid_modules = modules - valid_modules
    if invalid_modules or not modules:
        raise SystemExit('Módulos parciales inválidos: ' + ', '.join(sorted(invalid_modules or modules)))

    print('Leyendo', a.xlsx, '...', flush=True)
    xl = pd.ExcelFile(a.xlsx)
    required_sheets = HOJAS if full else (
        ['Dim_Clientes', 'Credito', 'CxC', 'Debito'] if modules else []
    )
    faltan = [h for h in required_sheets if h not in xl.sheet_names]
    if faltan:
        raise SystemExit('Faltan hojas en el Excel: ' + ', '.join(faltan))
    x = {h: xl.parse(h) for h in HOJAS}
    dimc, cred, deb, cxc = x['Dim_Clientes'], x['Credito'], x['Debito'], x['CxC']

    os.makedirs(os.path.dirname(os.path.abspath(a.db)), exist_ok=True)
    con = sqlite3.connect(a.db, timeout=60)
    cur = con.cursor()
    for table, column, definition in [
        ('cliente_extra', 'email', 'TEXT'),
        ('cliente_extra', 'telefono', 'TEXT'),
        ('cliente_extra', 'editado_app', 'INTEGER NOT NULL DEFAULT 0'),
        ('pagos', 'banco_id', 'INTEGER'),
        ('pagos', 'banco', 'TEXT'),
        ('debito_app', 'metodo', 'TEXT'),
        ('debito_app', 'banco_id', 'INTEGER'),
        ('debito_app', 'banco', 'TEXT'),
    ]:
        if not cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
            continue
        columns = {r[1] for r in cur.execute(f'PRAGMA table_info({table})')}
        if column not in columns:
            cur.execute(f'ALTER TABLE {table} ADD COLUMN {column} {definition}')
    app_invoice_clients = []
    prev_cli = []
    if not full:
        try:
            app_invoice_clients = cur.execute("""SELECT DISTINCT c.k_cliente,c.cliente,c.estacion_id,c.no_cliente,e.nombre
                FROM fact_cxc_app f JOIN dim_cliente c ON c.k_cliente=f.k_cliente
                JOIN dim_estacion e ON e.id=c.estacion_id""").fetchall()
        except sqlite3.Error:
            pass
        try:
            prev_cli = cur.execute("""SELECT ce.k_cliente,ce.cliente,ce.estacion_id,ce.no_cliente,ce.editado_app,e.nombre
                FROM cliente_extra ce LEFT JOIN dim_estacion e ON e.id=ce.estacion_id
                WHERE ce.creado_app=1 OR ce.editado_app=1""").fetchall()
        except sqlite3.Error:
            try:
                prev_cli = cur.execute("""SELECT ce.k_cliente,ce.cliente,ce.estacion_id,ce.no_cliente,0,e.nombre
                    FROM cliente_extra ce LEFT JOIN dim_estacion e ON e.id=ce.estacion_id
                    WHERE ce.creado_app=1""").fetchall()
            except sqlite3.Error:
                pass

    # ---------- Estaciones (conserva IDs existentes) ----------
    prev_est = {}
    try:
        prev_est = {n: i for i, n in cur.execute('SELECT id,nombre FROM dim_estacion')}
    except sqlite3.Error:
        pass
    est_names = sorted(set(dimc.ESTACION.dropna()) | set(cred.ESTACION.dropna()) |
                       set(deb.ESTACION.dropna()) | set(cxc.ESTACION.dropna()) |
                       {r[4] for r in app_invoice_clients} |
                       {r[5] for r in prev_cli if len(r) > 5 and r[5]})
    if not full:
        est_names = sorted(set(est_names) | set(prev_est))
    est = dict(prev_est)
    nxt = max(est.values(), default=0) + 1
    for n in est_names:
        if n not in est:
            est[n] = nxt; nxt += 1
    if full:
        est = {n: est[n] for n in est_names}

    # ---------- Clientes ----------
    dimc = dimc.drop_duplicates('K_Cliente').copy()
    cred = cred.drop_duplicates('K_Cliente').copy()
    extra_frames = []
    if full or 'cxc' in modules:
        extra_frames.append(cxc[['CLIENTE', 'ESTACION', 'K_Cliente']])
    if full or 'debito' in modules:
        extra_frames.append(deb[['CLIENTE', 'ESTACION', 'K_Cliente']])
    extra = (pd.concat(extra_frames).dropna(subset=['CLIENTE']).drop_duplicates('K_Cliente')
             if extra_frames else pd.DataFrame(columns=['CLIENTE', 'ESTACION', 'K_Cliente']))
    extra = extra[~extra.K_Cliente.isin(dimc.K_Cliente)]
    dimc = pd.concat([dimc, extra])
    nocli = cred.set_index('K_Cliente')['NO_CLIENTE'].map(lambda v: None if pd.isna(v) else str(int(v)))
    dim_rows = [(r.K_Cliente, str(r.CLIENTE).strip(), est[r.ESTACION], nocli.get(r.K_Cliente)) for r in dimc.itertuples()]
    claves = {r[0] for r in dim_rows}
    cred_rows = [(r.K_Cliente, float(r.LIMITE_DE_CREDITO or 0), int(r.DIAS_DE_CREDITO or 0)) for r in cred.itertuples() if r.K_Cliente in claves]

    # ---------- CxC ----------
    c = pd.DataFrame({
        'id': cxc['Índice'].astype(int), 'fecha_despacho': iso(cxc['FECHA']), 'despacho': txt(cxc['DESPACHO']),
        'importe': cxc['IMPORTE'].astype(float), 'abono': cxc['ABONO'].astype(float), 'k_cliente': cxc['K_Cliente'],
        'estacion_id': cxc['ESTACION'].map(est), 'estatus': txt(cxc['ESTATUS']), 'grupo': txt(cxc['GRUPO']),
        'fecha_factura': iso(cxc['FECHA FACTURA']), 'no_factura': txt(cxc['NO. FACTURA']),
        'fecha_pago': iso(cxc['FECHA PAGO']), 'fecha_vencimiento': iso(cxc['FECHA VENCIMIENTO']),
    })
    m = c.estatus.isna() & c.no_factura.notna()
    c.loc[m, 'estatus'] = 'POR PAGAR'          # facturado sin estatus = por pagar
    c['estatus'] = c.estatus.fillna('POR FACTURAR')
    c = c.drop_duplicates('id')

    # ---------- Facturas (agregado) ----------
    f = c[c.no_factura.notna()].copy()
    f['abierta'] = f.estatus.isin(['POR PAGAR', 'ABONADO']).astype(int)
    for col in ['fecha_factura', 'fecha_vencimiento', 'fecha_despacho']:
        f[col] = pd.to_datetime(f[col], errors='coerce')
    fac = f.groupby(['k_cliente', 'estacion_id', 'no_factura'], as_index=False).agg(
        fecha_factura=('fecha_factura', 'min'), fecha_vencimiento=('fecha_vencimiento', 'min'),
        primer_despacho=('fecha_despacho', 'min'), ultimo_despacho=('fecha_despacho', 'max'),
        despachos=('id', 'size'), importe=('importe', 'sum'), abono=('abono', 'sum'), abierta=('abierta', 'max'))
    for col in ['fecha_factura', 'fecha_vencimiento', 'primer_despacho', 'ultimo_despacho']:
        fac[col] = fac[col].dt.strftime('%Y-%m-%d')

    # ---------- Debito ----------
    d = pd.DataFrame({'fecha': iso(deb['FECHA']), 'folio': txt(deb['DESPACHO']), 'importe': deb['IMPORTE'].astype(float),
                      'abono': deb['ABONO'].astype(float), 'k_cliente': deb['K_Cliente'],
                      'estacion_id': deb['ESTACION'].map(est), 'grupo': txt(deb['GRUPO'])})
    d = d[(d.importe != 0) | (d.abono != 0)]
    d = d[d.k_cliente.isin(claves)]
    d['tipo'] = d.abono.gt(0).map({True: 'RECARGA', False: 'CONSUMO'})

    # ---------- Tiempo ----------
    rng = pd.date_range('2018-01-01', '2028-12-31', freq='D')
    t = pd.DataFrame({'fecha': rng.strftime('%Y-%m-%d'), 'anio': rng.year, 'trimestre': rng.quarter, 'mes': rng.month,
                      'mes_nombre': [MESES[i - 1] for i in rng.month], 'anio_mes': rng.strftime('%Y-%m'),
                      'semana': rng.isocalendar().week.astype(int).values, 'dia_semana': rng.dayofweek + 1,
                      'dia_nombre': [DIAS[i] for i in rng.dayofweek]})

    corte = pd.to_datetime(cxc['HOY'], errors='coerce').max()
    corte = corte.strftime('%Y-%m-%d') if pd.notna(corte) else dt.date.today().isoformat()

    # ---------- Escritura ----------
    previous_clients = {}
    previous_credit = {}
    try:
        previous_clients = {r[0]: r[1:] for r in cur.execute(
            'SELECT k_cliente,cliente,estacion_id,no_cliente FROM dim_cliente')}
        previous_credit = {r[0]: r[1:] for r in cur.execute(
            'SELECT k_cliente,limite,dias,origen,actualizado_por,actualizado FROM credito')}
    except sqlite3.Error:
        if not full:
            raise

    drop_sql = ''.join(f'DROP VIEW IF EXISTS {vw};\n' for vw in ['v_fact_factura', 'v_cxc', 'v_debito'])
    if full:
        application_tables = [
            'usuario_estaciones', 'sesiones', 'pagos', 'debito_app', 'fact_cxc_app',
            'cliente_extra', 'gestiones', 'bitacora', 'usuarios', 'bancos', 'metodos_pago',
        ]
        existing_tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        drop_sql += ''.join(f'DELETE FROM {table};\n' for table in application_tables if table in existing_tables)
        if 'sqlite_sequence' in existing_tables:
            drop_sql += "DELETE FROM sqlite_sequence;\n"
        drop_sql += ''.join(f'DROP TABLE IF EXISTS {tb};\n' for tb in
                            ['fact_cxc', 'fact_factura', 'fact_debito', 'credito', 'dim_cliente', 'dim_estacion', 'dim_tiempo', 'meta'])
    schema_sql = open(os.path.join(BASE, 'server', 'schema.sql'), encoding='utf-8').read()
    con.executescript('BEGIN IMMEDIATE;\n' + drop_sql + schema_sql)

    def ins(table, df, cols):
        rows = df[cols].astype(object).where(df[cols].notna(), None).values.tolist()
        cur.executemany(f"INSERT INTO {table}({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", rows)

    if full:
        cur.executemany('INSERT INTO dim_estacion VALUES (?,?)', [(i, n) for n, i in est.items()])
        cur.executemany('INSERT INTO dim_cliente VALUES (?,?,?,?)', dim_rows)
        cur.executemany('INSERT INTO credito(k_cliente,limite,dias) VALUES (?,?,?)', cred_rows)
        cur.execute('INSERT INTO credito(k_cliente,limite,dias) SELECT k_cliente,0,0 FROM dim_cliente WHERE k_cliente NOT IN (SELECT k_cliente FROM credito)')
    elif 'clientes_credito' in modules:
        required_clients = set()
        if 'cxc' not in modules:
            required_clients.update(r[0] for r in cur.execute('SELECT DISTINCT k_cliente FROM fact_cxc'))
        if 'debito' not in modules:
            required_clients.update(r[0] for r in cur.execute('SELECT DISTINCT k_cliente FROM fact_debito'))
        for table in ['pagos', 'debito_app', 'fact_cxc_app', 'gestiones']:
            required_clients.update(r[0] for r in cur.execute(f'SELECT DISTINCT k_cliente FROM {table}'))
        required_clients.update(r[0] for r in cur.execute(
            'SELECT k_cliente FROM cliente_extra WHERE creado_app=1 OR editado_app=1'))

        source_keys = {r[0] for r in dim_rows}
        retained_clients = {
            key: row for key, row in previous_clients.items()
            if key not in source_keys and key in required_clients
        }
        retained_credit = {
            key: row for key, row in previous_credit.items()
            if key in retained_clients
        }
        cur.execute('DELETE FROM dim_cliente')
        cur.executemany('INSERT INTO dim_cliente VALUES (?,?,?,?)', dim_rows)
        cur.executemany('INSERT INTO dim_cliente VALUES (?,?,?,?)',
                        [(key, *row) for key, row in retained_clients.items()])
        for name, station_id in est.items():
            cur.execute('INSERT OR IGNORE INTO dim_estacion(id,nombre) VALUES (?,?)', (station_id, name))
        cur.execute('DELETE FROM credito')
        cur.executemany('INSERT INTO credito(k_cliente,limite,dias) VALUES (?,?,?)', cred_rows)
        cur.execute('INSERT INTO credito(k_cliente,limite,dias) SELECT k_cliente,0,0 FROM dim_cliente WHERE k_cliente NOT IN (SELECT k_cliente FROM credito)')
        for key, row in retained_credit.items():
            cur.execute('UPDATE credito SET limite=?,dias=?,origen=?,actualizado_por=?,actualizado=? WHERE k_cliente=?',
                        (*row, key))
        for key, _name, station_id, _number in dim_rows:
            for table in ['fact_cxc', 'fact_factura', 'fact_debito', 'pagos', 'debito_app', 'fact_cxc_app']:
                cur.execute(f'UPDATE {table} SET estacion_id=? WHERE k_cliente=?', (station_id, key))

    if full or 'clientes_credito' in modules:
        known_stations = {r[0] for r in cur.execute('SELECT nombre FROM dim_estacion')}
    else:
        known_stations = set(prev_est)
    if 'cxc' in modules and not full:
        client_stations = dict(cur.execute('SELECT k_cliente,estacion_id FROM dim_cliente'))
        missing_clients = set(c.k_cliente.dropna()) - set(client_stations)
        missing_stations = set(cxc.ESTACION.dropna()) - known_stations
        changed_station = sum(1 for row in c.itertuples() if row.k_cliente in client_stations and
                              row.estacion_id != client_stations[row.k_cliente])
        if missing_clients or missing_stations or changed_station:
            raise SystemExit('No se puede cargar CxC parcialmente: carga Clientes y crédito junto con CxC. '
                             f'Clientes faltantes={len(missing_clients)}, estaciones faltantes={len(missing_stations)}, '
                             f'clientes con estación distinta={changed_station}')
    if 'debito' in modules and not full:
        client_stations = dict(cur.execute('SELECT k_cliente,estacion_id FROM dim_cliente'))
        missing_clients = set(d.k_cliente.dropna()) - set(client_stations)
        missing_stations = set(deb.ESTACION.dropna()) - known_stations
        changed_station = sum(1 for row in d.itertuples() if row.k_cliente in client_stations and
                              row.estacion_id != client_stations[row.k_cliente])
        if missing_clients or missing_stations or changed_station:
            raise SystemExit('No se puede cargar Débito parcialmente: carga Clientes y crédito junto con Débito. '
                             f'Clientes faltantes={len(missing_clients)}, estaciones faltantes={len(missing_stations)}, '
                             f'clientes con estación distinta={changed_station}')

    if full or 'cxc' in modules:
        cur.execute('DELETE FROM fact_cxc')
        cur.execute('DELETE FROM fact_factura')
        ins('fact_cxc', c, ['id', 'fecha_despacho', 'despacho', 'importe', 'abono', 'k_cliente', 'estacion_id', 'estatus', 'grupo',
                            'fecha_factura', 'no_factura', 'fecha_pago', 'fecha_vencimiento'])
        ins('fact_factura', fac, ['k_cliente', 'estacion_id', 'no_factura', 'fecha_factura', 'fecha_vencimiento', 'primer_despacho',
                                  'ultimo_despacho', 'despachos', 'importe', 'abono', 'abierta'])
        cur.execute('UPDATE pagos SET conciliado=1 WHERE conciliado=0')
    if full or 'debito' in modules:
        cur.execute('DELETE FROM fact_debito')
        ins('fact_debito', d, ['fecha', 'folio', 'tipo', 'importe', 'abono', 'k_cliente', 'estacion_id', 'grupo'])
        cur.execute('UPDATE debito_app SET conciliado=1 WHERE conciliado=0')

    if full:
        cur.execute('DELETE FROM dim_tiempo')
        cur.executemany('INSERT INTO dim_tiempo VALUES (?,?,?,?,?,?,?,?,?)', t.itertuples(index=False, name=None))
    metadata = {'fuente': os.path.basename(a.xlsx) if not os.path.basename(a.xlsx).startswith('carga_') else 'Gas_App.xlsx',
                'importado_en': dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
    if full or 'cxc' in modules:
        metadata['fecha_corte'] = corte
    for key, value in metadata.items():
        cur.execute('INSERT OR REPLACE INTO meta VALUES (?,?)', (key, value))
    con.commit()
    con.close()
    scope = 'completa' if full else ','.join(sorted(modules))
    print(f'OK  modo={scope} estaciones={len(est)} clientes={len(dim_rows)} cxc={len(c) if full or "cxc" in modules else "conservado"} '
          f'facturas={len(fac) if full or "cxc" in modules else "conservado"} '
          f'debito={len(d) if full or "debito" in modules else "conservado"}  corte={corte if full or "cxc" in modules else "conservado"}')

if __name__ == '__main__':
    main()
