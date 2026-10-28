'use strict';
// Quan ly tai khoan nhan vien tren may chu:
//   docker compose exec app node cli.js list
//   docker compose exec app node cli.js add <ten-dang-nhap> <vai-tro> [ten hien thi]   (vai tro: admin sale order kho tc)
//   docker compose exec app node cli.js reset <ten-dang-nhap>
//   docker compose exec app node cli.js lock <ten-dang-nhap>  |  unlock <ten-dang-nhap>
const store = require('./lib/store');
store.init();
const [cmd, user, role, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'list') console.table(store.listUsers());
  else if (cmd === 'add') console.log(`Tai khoan: ${user}\nMat khau: ${store.addUser(user, role, rest.join(' '))}`);
  else if (cmd === 'reset') console.log(`Tai khoan: ${user}\nMat khau moi: ${store.resetPassword(user)}`);
  else if (cmd === 'lock') { store.setActive(user, false); console.log('Da khoa ' + user); }
  else if (cmd === 'unlock') { store.setActive(user, true); console.log('Da mo ' + user); }
  else console.log('Lenh: list | add <user> <admin|sale|order|kho|tc> [ten] | reset <user> | lock <user> | unlock <user>');
} catch (e) {
  console.error('Loi: ' + e.message);
  process.exit(1);
}
