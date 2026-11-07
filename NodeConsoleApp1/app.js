//IP http://192.168.164.181:3010

const express = require('express');
const app = express();
const morgan = require('morgan');
const bodyParser = require('body-parser');
const mysql = require('mysql');
const Connection = require('./models/mySQLConnection')
const myConnection = require('express-myconnection')

//settings
app.set('port', process.env.PORT || 3010);

//middlewares
app.use(morgan('dev'));
app.use(bodyParser.json());

//Configuracion de la base de datos (host, usuario, contraseña, nombre de la DB y puerto)
const dbConfig = new Connection(
	'127.0.0.1',
	'root',
	'1234',
	'proyectodb',
	'3306'
);

app.use(myConnection(mysql, dbConfig.pool, 'pool'))

//routes
require('./routes/userRoutes')(app);


//statis files


app.listen(app.get('port'), () => {
		console.log('server on port 3010');
	});
