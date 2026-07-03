const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, unique: true },
  puppy: { type: mongoose.Schema.Types.ObjectId, ref: 'Puppy' },
  puppyName:    { type: String, required: true },
  puppyGender:  { type: String },
  puppyColor:   { type: String },
  puppyDOB:     { type: Date },
  puppyPrice:   { type: Number, required: true },
  depositPaid:  { type: Number, default: 0 },
  balanceDue:   { type: Number },
  clientName:   { type: String, required: true },
  clientEmail:  { type: String, required: true },
  clientPhone:  { type: String },
  clientAddress:{ type: String },
  deliveryMethod: { type: String, enum: ['Delivery', 'Local Pickup'], default: 'Delivery' },
  notes:        { type: String },
  signatureData:{ type: String },
  status:       { type: String, enum: ['Draft', 'Sent', 'Paid'], default: 'Draft' },
  sentAt:       { type: Date },
  createdAt:    { type: Date, default: Date.now }
});

module.exports = mongoose.model('Invoice', invoiceSchema);
