# Ledger

Append-only income and expenses (`ledger.csv`).
Columns: `date,tx_or_receipt,direction,counterparty,amount,token,category,independent(y/n),note`.
Categories include purchases via buy, facilitator fees, inference/token cost and customer revenue.
Team-owned traffic is marked `independent=n` and never counts as demand.
