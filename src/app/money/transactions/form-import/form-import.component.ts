import { Component, EventEmitter, OnInit } from '@angular/core';
import { PapaParseResult, PapaParseService } from 'ngx-papaparse';
import { Observable } from 'rxjs';
import { Account, ImportedRow, ITransactionData, Transaction, TransactionData } from '../../../../proto/model';
import { LoggerService } from '../../../core/logger.service';
import { timestampNow, timestampToWholeSeconds } from '../../../core/proto-util';
import { DataService } from '../../data.service';
import { FormatMapping } from './format-mapping';
import { MAPPINGS_BY_FORMAT } from './mappings';

type FileFormat = 'ksk_camt' | 'ksk_creditcard' | 'mlp';
type FileEncoding = 'windows-1252' | 'utf-8';

@Component({
  selector: 'app-form-import',
  templateUrl: './form-import.component.html',
  styleUrls: ['./form-import.component.css']
})
export class FormImportComponent implements OnInit {
  readonly allAccounts$: Observable<Account[]>;

  // Form data.
  private _file: File | null = null;
  private _fileFormat: FileFormat = 'ksk_camt';
  private _fileEncoding: FileEncoding = 'windows-1252';
  private _account: Account | null = null;
  private readonly formInputChange = new EventEmitter<void>();

  get file() { return this._file; }
  set file(value: File | null) { this._file = value; this.formInputChange.emit(); }
  get fileFormat() { return this._fileFormat; }
  set fileFormat(value: FileFormat) { this._fileFormat = value; this.formInputChange.emit(); }
  get fileEncoding() { return this._fileEncoding; }
  set fileEncoding(value: FileEncoding) { this._fileEncoding = value; this.formInputChange.emit(); }
  get targetAccount() { return this._account; }
  set targetAccount(value: Account | null) { this._account = value; this.formInputChange.emit(); }

  /**
   * Contains parsed transactions and raw row data to preview.
   * They are not yet linked to each other, because the rows will only get
   * their id once they are actually imported.
   */
  entriesToImport: { transaction: Transaction, row: ImportedRow }[] = [];

  /** Amount of existing rows that were found during parsing. */
  duplicateCount = 0;

  /** List of errors that happened during parsing. */
  errors: string[] = [];

  constructor(
    private readonly dataService: DataService,
    private readonly loggerService: LoggerService,
    private readonly papaService: PapaParseService
  ) {
    this.allAccounts$ = this.dataService.accounts$;
  }

  ngOnInit() {
    this.formInputChange.subscribe(() => this.updateFilePreview());
  }

  getPreviewMinDate(): Date | null {
    if (this.entriesToImport.length > 0) {
      return new Date(1000 * Math.min(...this.entriesToImport.map(
        e => timestampToWholeSeconds(e.transaction.single!.date)
      )));
    } else {
      return null;
    }
  }

  getPreviewMaxDate(): Date | null {
    if (this.entriesToImport.length > 0) {
      return new Date(1000 * Math.max(...this.entriesToImport.map(
        e => timestampToWholeSeconds(e.transaction.single!.date)
      )));
    } else {
      return null;
    }
  }

  private resetPreview() {
    this.entriesToImport = [];
    this.duplicateCount = 0;
    this.errors = [];
  }

  private updateFilePreview() {
    if (this.file) {
      const file = this.file;
      const fileFormat = this.fileFormat;
      this.papaService.parse(file, {
        beforeFirstChunk: firstChunk =>
          // Special case for MLP format: Strip preamble before header row.
          (fileFormat === 'mlp' && firstChunk.includes('"Buchungstag";"Valuta";"Auftraggeber')
            ? firstChunk.substr(firstChunk.indexOf('"Buchungstag";"Valuta";"Auftraggeber'))
            : firstChunk),
        header: true,
        skipEmptyLines: true,
        encoding: this.fileEncoding,
        complete: result => this.processFileContents(file.name, fileFormat, result),
      });
    } else {
      this.resetPreview();
    }
  }

  private processFileContents(fileName: string, fileFormat: FileFormat, csvData: PapaParseResult) {
    console.log(csvData);
    this.resetPreview();

    const mapping = MAPPINGS_BY_FORMAT[fileFormat];
    if (!mapping) {
      this.reportError("Invalid file format.");
      return;
    }

    if (!this.validateRequiredColumns(csvData.meta.fields, mapping)) {
      return;
    }

    if (!this.targetAccount) {
      this.reportError("Please select an account!");
      return;
    }

    const existingRows = this.dataService.getImportedRows();

    // Process rows.
    for (let i = 0; i < csvData.data.length; i++) {
      const row = csvData.data[i] as { [column: string]: string };

      if (this.isDuplicate(row, existingRows, mapping)) {
        this.duplicateCount++;
        continue;
      }

      // Create imported row without an id, which will be assigned
      // once (if) it is entered into the database.
      const importedRow = new ImportedRow({
        sourceFileName: fileName,
        fileFormat: this.fileFormat,
      });
      for (let field of csvData.meta.fields) {
        importedRow.values[field] = row[field];
      }

      const transactionProperties: ITransactionData = {};
      transactionProperties.created = timestampNow();
      transactionProperties.accountId = this.targetAccount ? this.targetAccount.id : 0;

      let hasErrors = false;
      for (let [key, mapperCallback] of Object.entries(mapping.mappings)) {
        let value: any;
        try { value = mapperCallback!(row); }
        catch (e) {
          this.reportError(`Import error in row ${i}: ${e}`);
          hasErrors = true;
          continue;
        }

        transactionProperties[key] = value;
      }
      if (hasErrors) {
        continue;
      }

      this.entriesToImport.push({
        row: importedRow,
        transaction: new Transaction({
          single: new TransactionData(transactionProperties),
        }),
      });
    }

    console.log(this.entriesToImport);
  }

  private validateRequiredColumns(presentColumns: string[], mapping: FormatMapping): boolean {
    const missingColumns = mapping.requiredColumns
      .filter(column => presentColumns.indexOf(column) === -1);
    if (missingColumns.length > 0) {
      this.reportError("Import failed: Required columns are missing from data: " + missingColumns.join(", "));
      return false;
    }
    return true;
  }

  private isDuplicate(row: { [column: string]: string }, existingRows: ImportedRow[], mapping: FormatMapping): boolean {
    return existingRows.some(existing => {
      // Check if the set of all mapped columns is identical to
      // the new row. This is supposed to provide some robustness
      // against small file format changes by only checking the fields
      // that are relevant to the app instead of all of them.
      for (let column of mapping.requiredColumns) {
        if (row[column] !== existing.values[column]) {
          return false;
        }
      }
      return true;
    });
  }

  private reportError(error: string) {
    this.errors.push(error);
    this.loggerService.error(error);
  }

}
