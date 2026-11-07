const mysql = require('mysql2')

class Connection{
    constructor(rhost, ruser, rpassword, rdatabase, rport){
        this.pool = mysql.createPool ({
            host: rhost,
            user: ruser,
            password: rpassword,
            database: rdatabase,
            port: rport,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        })

    }

    async getConnection() {
        return this.pool.getConnection();
    }

    async getParams(name){
        return new Promise((resolve, reject) =>{
            this.pool.query('SELECT parametros FROM documentos WHERE nombre = ?;', [name], (err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    console.log('RESULTADO:' + result[0].parametros)
                    resolve(result[0].parametros)
                }
            })
        })
        
    }

    async getData(myquery, callback) {
        return new Promise((resolve, reject) => {
            this.pool.query(myquery, (err, result, fields) => {
                if (err) {
                    reject(err)
                } else {

                    console.log('RESULTADO:' + result)
                    resolve(result) 
                    callback(null, result);
                }
            })
        }) 
    }

    async insertData(dato, segundo, myquery, callback) {
        return new Promise((resolve, reject) => {
            this.pool.query(myquery, [dato, segundo], (err, result, fields) => {
                if (err) {
                    reject(err)
                    callback(err, null)
                } else {
                    resolve(result)
                    callback(null, result)
                }
            });
        })
    }

    async getRuta(name){
        return new Promise((resolve, reject) =>{
            this.pool.query('SELECT ruta FROM documentos WHERE nombre = ?;', [name], (err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    console.log('RESULTADO:' + result[0].ruta)
                    resolve(result[0].ruta)
                }
            })
        }) 
    }

    async getDocumentos(){
        return new Promise((resolve, reject) =>{
            this.pool.query('SELECT nombre FROM documentos;', (err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    console.log('RESULTADO:' + result)
                    resolve(result)
                }
            })
        }) 
    }

    async newDocument(nombre, ruta){
        let tipo = nombre.split('.')
        tipo = tipo[tipo.length-1]
        return new Promise((resolve, reject) =>{
            this.pool.query('INSERT INTO documentos (nombre, ruta) VALUES (?, ?);',[nombre, ruta] ,(err, result, fields) => {
                if(err){
                    reject(err)
                }else{

                    switch(tipo){
                        case 'docx': tipo = 1
                            break;
                        case 'xlsx': tipo = 2
                            break;
                        case 'pdf': tipo = 3
                            break;
                    }

                    this.pool.query('INSERT INTO esTipo (id_documento, id_tipo) VALUES (LAST_INSERT_ID(), ?)', [tipo], (err, result, fields) => {
                        if(err){
                            reject(err)
                        }else{
                            resolve(result)
                        }
                    })
                }
            })
        }) 
    }

    async updateParametros(parametros){
        return new Promise((resolve, reject) =>{
            this.pool.query('UPDATE documentos SET parametros = ? WHERE id = LAST_INSERT_ID();',[parametros] ,(err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    resolve(result)
                }
            })
        })
    }

    //AQUI EMPEZAMOS A HACER LO DE LAS FIRMAS
    async getRutaFirma(name){
        return new Promise((resolve, reject) =>{
            this.pool.query('SELECT ruta_firma FROM firmas WHERE contraseña = ?;', [name], (err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    console.log('RESULTADO:' + result[0].ruta_firma)
                    resolve(result[0].ruta_firma)
                }
            })
        })
    }

    async newFirma(contraseña, ruta){
        return new Promise((resolve, reject) =>{
            this.pool.query('INSERT INTO firmas (contraseña, ruta_firma) VALUES (?, ?);',[contraseña, ruta] ,(err, result, fields) => {
                if(err){
                    reject(err)
                }else{
                    resolve(result)
                }
            })
        }) 
    }

}
module.exports = Connection;