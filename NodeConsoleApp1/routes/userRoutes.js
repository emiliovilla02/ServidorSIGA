const User = require('../models/user')

module.exports = function (app) {
	app.get('/users', (req, res) => {
		res.json('hola');
	});

	app.get('/metrics', (req, res) => {
		User.getMetrics(
			(err, data) => {
				//res.json({"foo" : "bar"}); 
				res.json(data)
			}
		);
	});

	app.get('/users2', (req, res)=>{
		User.getUsers( 
			(err, data) => {
				//res.json({"foo" : "bar"}); 
				res.json(data)
			}
		);
	});

	app.post('/metrics', (req, res) => {
		//console.log(req.body);		
		const userData = {
			id: req.body.id,
			result: req.body.result
		};

		User.insertResult(userData, (err, data) => {
			console.log(data)
			if (data && data.affectedRows) {
				res.status(200).json({
					success: true,
					msg: 'dato insertado',
					data: data
				});
			} else {
				res.status(500).json({
					success: false,
					msg: 'Error'
				});
			}
		});
	});

	app.post('/users', (req, res) => {
		//console.log(req.body);		
		const userData = {
			dato: req.body.dato,
			segundo: req.body.segundo
		};

		User.insertUser(userData, (err, data) => {
			console.log(data)
			if( data && data.affectedRows ){
				res.status(200).json({
					success: true,
					msg: 'dato insertado',
					data: data
				});
			}else{
				res.status(500).json({
					success: false,
					msg: 'Error'
				});
			}
		});
	});
}