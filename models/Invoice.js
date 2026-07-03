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
  signatureData:{ type: String }, // base64 PNG of Bryan's signature
  status:       { type: String, enum: ['Draft', 'Sent', 'Paid'], default: 'Draft' },
  sentAt:       { type: Date },
  createdAt:    { type: Date, default: Date.now }
});

// Auto-generate invoice number before save
invoiceSchema.pre('save', async function(next) {
  if (!this.invoiceNumber) {
    const year = new Date().getFullYear();
    const count = await mongoose.model('Invoice').countDocuments();
    this.invoiceNumber = `SBK-${year}-${String(count + 1).padStart(4, '0')}`;
  }
  if (!this.balanceDue) {
    this.balanceDue = this.puppyPrice - (this.depositPaid || 0);
  }
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
