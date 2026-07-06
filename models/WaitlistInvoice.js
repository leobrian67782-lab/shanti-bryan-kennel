const mongoose = require('mongoose');

const waitlistInvoiceSchema = new mongoose.Schema({
  receiptNumber: { type: String, unique: true },
  waitlist:      { type: mongoose.Schema.Types.ObjectId, ref: 'Waitlist' },

  clientName:    { type: String, required: true },
  clientEmail:   { type: String, required: true },
  clientPhone:   { type: String },
  clientAddress: { type: String },

  preferredGender: { type: String },
  preferredColor:  { type: String },

  depositAmount: { type: Number, required: true },
  notes:         { type: String },
  signatureData: { type: String },

  status: { type: String, enum: ['Draft', 'Sent'], default: 'Draft' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('WaitlistInvoice', waitlistInvoiceSchema);
