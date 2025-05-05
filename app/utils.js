export function rmEmptyValues(obj) {
  for (const key in obj) {
    if (obj[key] == null) {
      delete obj[key];
    } else if (typeof obj[key] === 'object') {
      rmEmptyValues(obj[key]); // Recursively check nested objects
      if (Object.keys(obj[key]).length === 0) {
        delete obj[key]; // Delete empty objects after processing
      }
    }
  }
  return obj;
}

export function btoa(data) {
	return Buffer.from(data).toString('base64');
};

export function  atob(base64) {
	return Buffer.from(base64, 'base64').toString('binary');
}

export default {
	rmEmptyValues,
	atob,
	btoa
};
