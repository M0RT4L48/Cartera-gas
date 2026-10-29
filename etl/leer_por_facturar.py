#!/usr/bin/env python
# -*- coding: utf-8 -*-
import json
import math
import sys
import unicodedata

import pandas as pd
from openpyxl.utils.datetime import from_excel


COLUMNAS = [
    'FECHA', 'DESPACHO', 'IMPORTE', 'ABONO', 'CLIENTE', 'GRUPO',
    'FECHA FACTURA', 'NO. FACTURA', 'FECHA PAGO',
]


def vacio(valor):
    return valor is None or pd.isna(valor) or str(valor).strip() == ''


def texto(valor):
    return '' if vacio(valor) else str(valor).strip()


def fecha(valor, fila, columna, errores, obligatoria=False):
    if vacio(valor):
        if obligatoria:
            errores.append(f'Fila {fila}: {columna} es obligatoria.')
        return None
    try:
        if isinstance(valor, (int, float)) and math.isfinite(float(valor)):
            valor = from_excel(valor)
        parsed = pd.to_datetime(valor, errors='coerce', dayfirst=True)
        if pd.isna(parsed):
            raise ValueError()
        return parsed.strftime('%Y-%m-%d')
    except (TypeError, ValueError, OverflowError):
        errores.append(f'Fila {fila}: {columna} no contiene una fecha válida.')
        return None


def importe(valor, fila, columna, errores, obligatorio=False):
    if vacio(valor):
        if obligatorio:
            errores.append(f'Fila {fila}: {columna} es obligatorio.')
        return 0.0
    try:
        resultado = float(str(valor).replace('$', '').replace(',', '').strip())
        if not math.isfinite(resultado):
            raise ValueError()
        return round(resultado, 2)
    except (TypeError, ValueError):
        errores.append(f'Fila {fila}: {columna} debe ser numérico.')
        return 0.0


def main(ruta):
    libro = pd.ExcelFile(ruta)
    if not libro.sheet_names:
        raise ValueError('El archivo no contiene hojas de cálculo.')
    tabla = pd.read_excel(libro, sheet_name=0, dtype=object)
    recibidas = list(tabla.columns)
    if recibidas != COLUMNAS:
        raise ValueError('Estructura incorrecta. Las columnas deben ser exactamente y en este orden: ' + ', '.join(COLUMNAS))

    errores = []
    registros = []
    despachos = set()
    for indice, fila in tabla.iterrows():
        valores = fila.to_dict()
        if all(vacio(v) for v in valores.values()):
            continue
        numero_fila = int(indice) + 2
        despacho = texto(valores['DESPACHO'])
        cliente = texto(valores['CLIENTE'])
        fecha_despacho = fecha(valores['FECHA'], numero_fila, 'FECHA', errores, True)
        monto = importe(valores['IMPORTE'], numero_fila, 'IMPORTE', errores, True)
        abono = importe(valores['ABONO'], numero_fila, 'ABONO', errores)
        if not despacho:
            errores.append(f'Fila {numero_fila}: DESPACHO es obligatorio.')
        if not cliente:
            errores.append(f'Fila {numero_fila}: CLIENTE es obligatorio.')
        if monto <= 0:
            errores.append(f'Fila {numero_fila}: IMPORTE debe ser mayor que cero.')
        if abono < 0 or abono >= monto:
            errores.append(f'Fila {numero_fila}: ABONO debe ser mayor o igual a cero y menor que IMPORTE.')

        clave_despacho = unicodedata.normalize('NFKC', despacho).strip().casefold()
        if clave_despacho:
            if clave_despacho in despachos:
                errores.append(f'Fila {numero_fila}: DESPACHO duplicado en el archivo ({despacho}).')
            despachos.add(clave_despacho)

        registros.append({
            'fila': numero_fila,
            'fecha_despacho': fecha_despacho,
            'despacho': despacho,
            'importe': monto,
            'abono': abono,
            'cliente': cliente,
            'grupo': texto(valores['GRUPO']),
            'fecha_factura': fecha(valores['FECHA FACTURA'], numero_fila, 'FECHA FACTURA', errores),
            'no_factura': texto(valores['NO. FACTURA']),
            'fecha_pago': fecha(valores['FECHA PAGO'], numero_fila, 'FECHA PAGO', errores),
        })

    if not registros:
        errores.append('El archivo no contiene registros para importar.')
    if errores:
        raise ValueError('\n'.join(errores[:100]))
    print(json.dumps(registros, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main(sys.argv[1])
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)