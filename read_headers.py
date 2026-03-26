import openpyxl
import json

wb = openpyxl.load_workbook(
    'templates/products-and-offers-en_GB-20260302191642.xlsx',
    read_only=True,
    data_only=True
)

ws = wb.worksheets[0]
print(f"Sheet name: {ws.title}")

rows_checked = 0
for i, row in enumerate(ws.iter_rows(max_row=10, values_only=True), start=1):
    non_empty = [v for v in row if v is not None and v != '']
    if len(non_empty) >= 2:
        print(f"ROW {i}: {json.dumps(list(row), default=str)}")
        rows_checked += 1
        if rows_checked >= 3:
            break

wb.close()
