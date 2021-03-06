import { Component, Inject, OnInit } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA } from '@angular/material';
import { Observable } from 'rxjs';
import { Account, BillingInfo, Money, Transaction, TransactionData } from '../../../../proto/model';
import { dateToTimestamp, moneyToNumber, numberToMoney, timestampToDate } from '../../../core/proto-util';
import { makeSharedDate, pushDeduplicate } from '../../../core/util';
import { CurrencyService } from '../../currency.service';
import { DataService } from '../../data.service';

export const MODE_ADD = 'add';
export const MODE_EDIT = 'edit';

@Component({
  selector: 'app-transaction-edit',
  templateUrl: './transaction-edit.component.html',
  styleUrls: ['./transaction-edit.component.css']
})
export class TransactionEditComponent implements OnInit {
  readonly allAccounts$: Observable<Account[]>;

  transaction: Transaction;
  /** the value of transaction.single for easier access */
  singleData: TransactionData;
  editMode: typeof MODE_ADD | typeof MODE_EDIT;

  private _isNegative: boolean;
  get isNegative(): boolean { return this._isNegative; }
  set isNegative(value: boolean) {
    this._isNegative = value;
    // Update sign on change.
    this.setAmount(moneyToNumber(this.singleData.amount));
  }

  constructor(
    @Inject(MAT_DIALOG_DATA) data: { transaction: Transaction, editMode: typeof MODE_ADD | typeof MODE_EDIT },
    private readonly dataService: DataService,
    private readonly currencyService: CurrencyService,
    private readonly matDialogRef: MatDialogRef<TransactionEditComponent>,
  ) {
    if (data.transaction.dataType !== "single") {
      throw new Error("cannot edit group transactions yet");
    }
    this.allAccounts$ = this.dataService.accounts$;

    this.transaction = data.transaction;
    this.singleData = data.transaction.single!;
    this.editMode = data.editMode;

    if (!this.transaction.billing) {
      this.transaction.billing = new BillingInfo();
    }
    if (!this.singleData.amount) {
      this.singleData.amount = new Money();
    }

    this._isNegative = moneyToNumber(this.singleData.amount) <= 0;
  }

  ngOnInit() {
  }

  getAccount(): Account {
    return this.dataService.getAccountById(this.singleData.accountId);
  }

  isAccountDefault(): boolean {
    return this.singleData.accountId === this.dataService.getUserSettings().defaultAccountIdOnAdd;
  }

  setAccountDefault() {
    this.dataService.getUserSettings().defaultAccountIdOnAdd = this.singleData.accountId;
  }

  setDate(dateString: string) {
    if (dateString) {
      this.singleData.date = dateToTimestamp(new Date(dateString));
    }
  }

  getDate = makeSharedDate(() => {
    return timestampToDate(this.singleData.date);
  });

  setAmount(amount: number | null) {
    if (amount) {
      // Sign always matching form selection, round to 2 digits.
      const amountSign = (this.isNegative ? -1 : 1);
      const newAmount = numberToMoney(amountSign * Math.abs(amount));
      this.singleData.amount!.units = newAmount.units;
      this.singleData.amount!.subunits = newAmount.subunits;
    } else {
      // Treat all falsy values as zero.
      this.singleData.amount!.units = 0;
      this.singleData.amount!.subunits = 0;
    }
  }

  getAbsoluteAmount(): number {
    return Math.abs(moneyToNumber(this.singleData.amount));
  }

  getCurrencySymbol(): string {
    return this.currencyService.getSymbol(this.getAccount().currency);
  }

  addLabel(newLabel: string) {
    pushDeduplicate(this.transaction.labels, newLabel);
  }

  deleteLabel(label: string) {
    const index = this.transaction.labels.indexOf(label);
    if (index !== -1) {
      this.transaction.labels.splice(index, 1);
    }
  }

  getDateCreated = makeSharedDate(() => {
    return timestampToDate(this.singleData.created);
  });

  getDateModified = makeSharedDate(() => {
    return this.singleData.modified ? timestampToDate(this.singleData.modified) : null;
  });

  onSubmit() {
    this.matDialogRef.close(true);
  }

}
