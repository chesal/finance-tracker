import { Injectable } from "@angular/core";
import { BehaviorSubject } from "rxjs";
import { DataContainer, ImportedRow, Transaction, TransactionData } from "../../proto/model";
import { pluralizeArgument } from "../core/util";
import { extractTransactionData, forEachTransactionData, isSingle } from "./model-util";

@Injectable({
  providedIn: 'root'
})
export class DataService {
  private data = new DataContainer();
  private highestImportedRowId = 0;
  private readonly transactionsSubject = new BehaviorSubject<Transaction[]>([]);

  readonly transactions$ = this.transactionsSubject.asObservable();

  setDataContainer(data: DataContainer) {
    this.data = data;
    this.updateHighestImportedRowId();
    this.notifyTransactions();
  }

  getDataContainer(): DataContainer {
    return this.data;
  }

  getCurrentTransactionList(): Transaction[] {
    return this.data.transactions || [];
  }

  removeTransactions(toRemove: Transaction | Transaction[]) {
    const transactions = pluralizeArgument(toRemove);
    for (let transaction of transactions) {
      const index = this.data.transactions.indexOf(transaction);
      this.data.transactions.splice(index, 1);
    }
    this.notifyTransactions();
  }

  addTransactions(toAdd: Transaction | Transaction[]) {
    // Validate all importedRowIds.
    forEachTransactionData(toAdd,
      data => this.validateImportedRowId(data.importedRowId));

    this.data.transactions = this.data.transactions.concat(toAdd);
    this.notifyTransactions();
  }

  addImportedRows(toAdd: ImportedRow | ImportedRow[]) {
    const rows = pluralizeArgument(toAdd);
    if (rows.some(row => row.id !== 0)) {
      throw new Error("rows with existing ids cannot be added to the database");
    }
    for (let row of rows) {
      row.id = ++this.highestImportedRowId;
      this.data.importedRows.push(row);
    }
  }

  removeImportedRow(rowId: number) {
    if (this.getTransactionDataReferringToImportedRow(rowId).length > 0) {
      throw new Error(`cannot delete row ${rowId} because it has a transaction referring to it`);
    }

    const index = this.data.importedRows.findIndex(row => row.id === rowId);
    if (index === -1) {
      throw new Error(`cannot delete row ${rowId} because it was not found`);
    }
    this.data.importedRows.splice(index, 1);
    if (this.highestImportedRowId === rowId) {
      this.updateHighestImportedRowId();
    }
  }

  getAllLabels(): string[] {
    const labels: string[] = [];
    for (let transaction of this.data.transactions) {
      for (let label of transaction.labels) {
        if (labels.indexOf(label) === -1) {
          labels.push(label);
        }
      }
    }
    return labels;
  }

  getImportedRowById(id: number): ImportedRow | null {
    return this.data.importedRows.find(row => row.id === id) || null;
  }

  /** Returns all imported rows. DO NOT MODIFY THE RETURNED ARRAY. */
  getImportedRows(): ImportedRow[] {
    return this.data.importedRows;
  }

  getTransactionsReferringToImportedRow(importedRowId: number): Transaction[] {
    return this.data.transactions.filter(transaction => {
      if (isSingle(transaction)) {
        return transaction.single.importedRowId === importedRowId;
      } else {
        return transaction.group!.children.some(child => child.importedRowId === importedRowId);
      }
    });
  }

  getTransactionDataReferringToImportedRow(importedRowId: number): TransactionData[] {
    return extractTransactionData(this.data.transactions).filter(data => data.importedRowId === importedRowId);
  }

  private notifyTransactions() {
    this.transactionsSubject.next(this.data.transactions);
  }

  private updateHighestImportedRowId() {
    if (this.data.importedRows.length > 0) {
      this.highestImportedRowId =
        Math.max(...this.data.importedRows.map(row => row.id));
    } else {
      this.highestImportedRowId = 0;
    }
  }

  private validateImportedRowId(rowId: number) {
    if (rowId === 0) return;
    if (rowId < 0) {
      throw new Error("importedRowId may not be negative");
    }
    if (!this.data.importedRows.some(row => row.id === rowId)) {
      throw new Error(`linked importedRowId ${rowId} was not found in the database`);
    }
  }
}
